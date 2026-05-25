# TrendIQ Design

**Created:** 2026-05-25
**Status:** V1 design locked; Phase 1 implementation in progress.
Methodology locks added 2026-05-25 (see "Phase 1 methodology locks"
section below).
**Strategic positioning:** Headline forward-looking score for CompIQ
predictions. Comps demoted to reference data. Makes HobbyIQ's
predictive intelligence (the strategic moat) visible in product UI.

## Name

TrendIQ. Locked. Fits the IQ family (CompIQ, ActionIQ, DailyIQ,
InventoryIQ, TrendIQ). Plain-language directional word that handles
both up and down polarity naturally.

## Data layer — three-input composite

TrendIQ composites three data inputs into a single per-card score:

**1. Player-level signal momentum**
Source: aggregator's final_mult from aggregated.json (produced by
fn-signal-aggregator).
Captures: news catalysts, search trends, performance stats, social
activity, betting odds, listing velocity, content trends.
Updated: every ~2 hours per aggregator cycle.
Current state: 3 of 7 signals active (trends, news, stats); 4
degraded (reddit, ebay, odds, youtube) pending credential repair.

**2. Card-level comp trajectory**
Source: recent comps for the specific card being valued.
Captures: whether this exact card's recent sale prices are
rising, falling, or steady.
Methodology specifics deferred to implementation time (window size,
calculation method, "sparse" threshold).

**3. Market segment trajectory anchored to last sale date**
Source: comps for related parallels — same player + same year +
same **set** (e.g. "Bowman Chrome Prospects") — over a dynamic
window from this card's last sale date to present.
Captures: how the broader market segment has moved since this
specific card was last priced by an actual transaction.
Solves: low-pop parallel valuation problem (rare cards with sparse
direct comps still get meaningful trend signal from segment).
Refined 2026-05-25: segment scoped to "set" rather than "brand".
Set-level segments capture product-line momentum cleanly; brand-
level would pool unrelated product lines under the same manufacturer
(e.g. Topps Bowman Chrome vs Topps Heritage have different
collector bases and shouldn't share a trajectory).

## Composite weighting

Dynamic, not fixed. Weighting shifts based on data density:

- Common cards with rich card-level comp data: card-level trajectory
  carries primary weight; segment trajectory provides supporting context
- Rare cards with sparse direct comps: segment trajectory anchored to
  last sale date carries primary weight (substitute for absent
  card-specific trend)
- Player momentum always contributes as broader-market context

Locked weight table — see "Phase 1 methodology locks" section below
for the full 8-row availability matrix.

## Display approach (Approach C — locked)

Single composite headline number per card with tap-to-details
breakdown showing all three components.

## Phase 1 methodology locks (2026-05-25)

Everything below was deferred at design time and is now locked for the
Phase 1 backend implementation. These bake in math the user will see
and were authorized explicitly before B.4 implementation began.

**Layer 2 — card-level comp trajectory:**

- Recent window: 0..14 days from now (inclusive)
- Older window: 15..45 days from now
- Minimum: 2 comps in recent AND 2 in older — below threshold, layer
  reports null and drops out of composite
- pctChange clamp: ±50% (tighter than broaderTrend's ±60% — card-level
  is noisier)

**Layer 3 — segment trajectory:**

- Pool: siblings via `searchCardsRouted` for `${year} ${set} ${player}`,
  filtered to same player + same year + same set, exact card_id
  excluded. Caps: 8 siblings, 10 samples each (same as broaderTrend).
- Anchor handling:
  - `originalAnchorDate`: this card's true last-sale ISO date, or null
    if never sold
  - `effectiveAnchorDate`: the date actually used as window pivot
  - If anchor > 180 days ago: re-anchor to `now - 90d` (i.e.
    effectiveAnchorDate = now-90d); both dates surfaced so UI can
    transparently say "Last sale: 250 days ago — segment trajectory
    uses 90-day window"
  - If anchor < 7 days ago: post-anchor window too short → layer = null
  - If `originalAnchorDate == null` (no exact sales): layer = null
- Windowing (Option C resolution, locked 2026-05-26):
  - **Pre-window**: ALWAYS 30 days immediately before
    `effectiveAnchorDate`. Decoupled from `windowDays` to fix an
    arithmetic conflict in the original spec (with `windowDays = 60`
    and re-anchor moving effectiveAnchorDate to `now-90d`, the original
    `soldDate >= (now − 60d)` floor produced an empty `[now-60d,
    now-90d]` pre-anchor interval, defeating the re-anchor feature).
  - **Post-window**: `(effectiveAnchorDate, now]`.
  - **Total `windowDays` reported**: `30 + (days from effective anchor
    to now)`. Normal case (anchor ~30d ago) = 60 days. Re-anchored
    case (effective = now-90d) = 120 days.
- Pre-anchor pool: sibling sales with `soldDate <= effectiveAnchorDate
  AND soldDate >= (effectiveAnchorDate − 30d)`
- Post-anchor pool: sibling sales with `soldDate > effectiveAnchorDate
  AND soldDate <= now`
- Minimum: 2 in pre-anchor AND 2 in post-anchor — below → layer null
- pctChange clamp: ±50%

**Production status (B.4.c ship, 2026-05-26):** Layer 3 is implemented
against this spec but blocked behind CF-CARDSIGHT-SIBLING-DISCOVERY.
Cardsight's catalog data model differs structurally from CardHedge —
cards organized by release + subset + parallel with player attribution
outside the catalog card. `searchCardsRouted + filter` returns 0
siblings in production, so segment trajectory is always null until
upstream sibling discovery is rebuilt for Cardsight. Composite falls
back to two-layer (player + card) in the meantime. Diagnostic logs
`[compiq.trendIQ.L3]` surface the null reason in stdout for ops
visibility.

**Composite weighting (8-row availability matrix):**

`Y` = layer populated, `N` = layer null/missing.

| L1 player | L2 card | L3 segment | weights {p, c, s}  | coverage     |
|-----------|---------|------------|--------------------|--------------|
| Y         | Y       | Y          | {0.20, 0.40, 0.40} | full         |
| Y         | Y       | N          | {0.30, 0.70, 0.00} | no_segment   |
| Y         | N       | Y          | {0.30, 0.00, 0.70} | no_card      |
| Y         | N       | N          | {1.00, 0.00, 0.00} | player_only  |
| N         | Y       | Y          | {0.00, 0.50, 0.50} | full (no L1) |
| N         | Y       | N          | {0.00, 1.00, 0.00} | card_only    |
| N         | N       | Y          | {0.00, 0.00, 1.00} | segment_only |
| N         | N       | N          | composite=1.0 flat | insufficient |

Rationale: player momentum is "broader market context" — never primary
when comp-derived layers exist. Card and segment are co-equal when both
have data. Segment takes over when card is sparse (the rare-card case).

**Composite math:**

- Per-layer multiplier conversion: `m = clamp(0.70, 1.50, 1 + pct/100)`
- Composite: `clamp(0.70, 1.50, w₁·m₁ + w₂·m₂ + w₃·m₃)`
- impliedPct: `round((composite − 1) × 100, 1)`

**Direction deadband:**

- composite ∈ [0.97, 1.03] → "flat" (±3% suppresses noise display)
- < 0.97 → "down"
- &gt; 1.03 → "up"

**Caching strategy:**

- Sibling sales fetched once per estimate, shared between
  `fetchBroaderTrend` (existing) and `computeSegmentTrajectory` (new)
- Cardsight LRU handles per-sibling cache
- Route-level `cacheWrap(CACHE_TTL_SECONDS)` covers full /price response
- Signal fetch uncached for V1 (~50ms typical; aggregator updates every
  ~2h so fresh-ish always)

**Telemetry:**

- Single grep-able production log per estimate:
  `[compiq.trendIQ] composite=X.XX direction=Y coverage=Z weights=p:X.XX/c:X.XX/s:X.XX`
- `trackHttpDependency` wrap on signal fetch IF backend already has
  `@opentelemetry/api`. Otherwise HALT before pulling in new dep.

**Shared-folder structure:**

- `fetchSignals` + types ported into `backend/src/services/signals/`
  with PROVENANCE comment referencing `mcp-server/pricing.ts:223`.
- FOLLOWUP marker for extraction into a shared workspace if a third
  consumer ever appears.

## Deferred to Phase 2+ (still open)

- Display format (signed delta vs 100% baseline vs directional words
  like "Up 12%") — iOS work
- Color coding specifics (green/gray/red spectrum, exact shades,
  accessibility) — iOS work
- Display threshold for "since last sale" framing in details view —
  iOS work
- Methodology graduation (currently binary on/off per layer; could
  graduate weights based on sample-count density in V2)

## Implementation phases (~16-25 hours total)

### Phase 1 — Backend exposure (~8-12 hours)

- Modify /api/compiq/price response to include trendIQ object
- Include: composite multiplier, last-updated timestamp, signal flags,
  component breakdown (player/card/segment values), coverage status,
  "since last sale date" context
- Backend logic for segment-trajectory computation anchored to
  last sale date
- Backend logic for dynamic composite weighting
- Tests for response shape and edge cases
- Source-deploy via hardened script

### Phase 2 — iOS CompIQ result view redesign (~4-6 hours)

- Decode trendIQ from backend response
- Display format decision (see deferred section)
- UI: TrendIQ headline, color coding, tap-to-details breakdown
- Demote recent comps to "reference data" section

### Phase 3 — Surface across other views (~3-5 hours)

- PortfolioIQView, DashboardView, InventoryIQView, DailyIQView
- Consistent display per Phase 2 decisions

### Phase 4 — Methodology help screen (~2-3 hours)

- Explain TrendIQ to users
- Show component signals + which are active
- Set expectations: forward-looking estimate, not guarantee

## Cross-references

- Backend: services/compiq/compiqEstimate.service.ts (where trendIQ
  data assembly will live)
- Aggregator: compiq-functions/fn-signal-aggregator/ (produces source
  data for Layer 1)
- iOS: HobbyIQ/CompIQResult.swift (decode target), CompIQPricedCardView
  or equivalent (display target)
- Related CFs: CF-CROSS-COMPANY-COMPS (BGS/CGC inclusion becomes more
  important when Layer 3 segment trajectory pulls parallels)

## Production Status (2026-05-25)

TrendIQ Phase 1 shipped to production at SHA `a5d5151`.

**Active in production:**

- ✅ **Layer 1 (player momentum)** — verified live with tracked players
  via `/api/compiq/price` smoke. Real signal multipliers flow from
  aggregator (`fn-compiq.azurewebsites.net/api/signals`) through
  `fetchPlayerSignals` to the composite. App Insights `dependencies`
  table populated with sanitized URLs + duration + status codes.
- ✅ **Layer 2 (card-level comp trajectory)** — verified live with
  rich-comp cards (Ohtani, Griffey). Multipliers correctly clamped to
  [0.70, 1.50] with the asymmetric multiplier behavior documented in
  the unit tests.
- 🛠 **Layer 3 (segment trajectory)** — CF-CARDSIGHT-SIBLING-DISCOVERY
  Approach A implementation shipped to `main` 2026-05-25; deployment to
  production is a separate authorization (still at `a5d5151` pre-fix
  at time of this update). Local smoke verified: Torres (rare-card
  case, anchor 65d) reaches `coverage=no_card` with `segmentTrajectory`
  populated for the first time ever — 7 siblings / 16 sales discovered
  via `fetchCompsByPlayer` wrap. High-volume cards (Ohtani 5.9d anchor)
  remain `null` via the locked `<7d` rule (methodology working as
  designed for that case).
  - **CF-CARDSIGHT-SIBLING-DISCOVERY (primary)** — RESOLVED via
    Approach A: `fetchSiblingSales` body replaced with a wrap of
    `fetchCompsByPlayer` + exact-card-id exclusion. Implementation
    composition over the production-tested `compsByPlayer.service.ts`
    (shipped 2026-05-27 for adjacent MCP-rewire flow). Inherits the
    `lookupReleaseName` dictionary, chrome fallback, top-K pricing
    fanout, and 6h aggregate cache.
  - **`/price-by-id` fallback path gap (secondary, observed in
    production traces 2026-05-25)**: the `parsedQuery` fallback
    added in B.4.c works for `/price` (which goes through
    `parseCardQuery + requestFromParsed` and produces a structured
    `body.product`/`body.cardYear`) but is bypassed on
    `/price-by-id`'s minimal-body path where `body.product` is
    undefined. iOS production traffic on `/price-by-id` produces
    `fallback.set=undefined fallback.year=undefined` log lines and
    Layer 3 returns null for that reason on top of the primary gap.
    Folded into CF-CARDSIGHT-SIBLING-DISCOVERY scope.
- ✅ **Composite weighting** — verified live for `no_segment`
  (Ohtani: weights {0.30, 0.70, 0.00}) and `card_only` (Griffey:
  weights {0.00, 1.00, 0.00}) coverage states. The 4 coverage states
  involving Layer 3 (`full`, `no_card`, `segment_only`, and the
  `full (no L1)` row) will activate once Layer 3 unblocks.
- ✅ **Composite math verified live**: `0.3 × 1.041 + 0.7 × 1.136 =
  1.108` matches returned composite within float tolerance.

**All three CompIQ endpoints surface trendIQ:**

- `/api/compiq/price` — verified prod
- `/api/compiq/price-by-id` — verified prod
- `/api/compiq/bulk` — verified prod (per-item trendIQ, Promise.allSettled
  isolates failures)

**Diagnostic logs visible via App Insights `hobbyiq-insights` resource:**

- `[compiq.trendIQ] composite=X.XX direction=Y coverage=Z weights=p:X.XX/c:X.XX/s:X.XX`
- `[compiq.trendIQ.L3] null reason=... siblings=N poolSales=N ...`
  (surfaces null causes for Layer 3 in real time)
- `[compiq.trendIQ.L3.fetch] player="..." set="..." year="..." ...`
  (fetchSiblingSales funnel diagnostic)

**App Service env vars configured:**

- `AZURE_SIGNAL_FUNCTION_URL` set on hobbyiq3
- `AZURE_SIGNAL_FUNCTION_KEY` set on hobbyiq3
- (Pulled from `compiq-mcp` config, same Azure Function endpoint)

**Production telemetry pattern observed:**

- Tracked players (Ohtani, Skenes, etc.) return `200 OK` from signal
  endpoint with real multipliers and signal flags.
- Untracked players (Griffey, etc.) return `404 Not Found` from signal
  endpoint; `fetchPlayerSignals` correctly returns `null` payload;
  `buildPlayerMomentumComponent` returns null component; composite
  falls back to L2-only weights `{0, 1, 0}`.

**Next priorities (in order):**

1. **CF-CARDSIGHT-SIBLING-DISCOVERY** — unblock Layer 3 in production
   (3-6h research + implementation; includes the `/price-by-id`
   fallback edge case as in-scope)
2. **CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS** — retire parsedQuery
   fallback if Cardsight exposes setName/year via different endpoint
   (1-2h)
3. **TrendIQ Phase 2** — iOS surfacing (CompIQ result UI redesign
   with TrendIQ headline)
4. **TrendIQ Phase 3** — surface across PortfolioIQ, Dashboard,
   InventoryIQ
5. **TrendIQ Phase 4** — methodology help screen

## V2 considerations (post-V1 implementation)

- Cross-company segment expansion (include BGS/CGC parallels in
  segment trajectory once CF-CROSS-COMPANY-COMPS resolves)
- Per-product-line segment refinement (within brand)
- Outcome feedback loop integration (predicted TrendIQ vs actual
  sale outcomes feeding back into Layer 1 aggregator weighting)
- Methodology evolution based on backtest validation
