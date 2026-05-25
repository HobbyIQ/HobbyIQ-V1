# CF-CARDSIGHT-SIBLING-DISCOVERY — Investigation Findings

**Date:** 2026-05-25
**Workstream type:** Read-only investigation. No production code changes.
**Time budget:** 2-3 hours.
**Source artifacts:** code-reading only — `cardsight.client.ts`, `cardsight.router.ts`,
`compsByPlayer.service.ts`, `cardsight.mapper.ts`, plus `docs/phase0/cardsight_*.md`.
Live API probing (I.2) was authorized as a possible follow-on but **skipped** —
code + existing docs were conclusive.

**Headline outcome:** A working solution already exists in the codebase
(`fetchCompsByPlayer` in `backend/src/services/compiq/compsByPlayer.service.ts`,
shipped 2026-05-27 for an adjacent MCP-rewire flow). Implementation scope
revised from the CF's original 3-6h estimate to **~1-2h composition + ~30-60min
tests/smoke**. The implementation itself is a separate authorized workstream;
this doc captures the investigation only.

## 1. Cardsight integration — current state

### Endpoints exposed at `https://api.cardsight.ai/v1`

All three live in [`backend/src/services/compiq/cardsight.client.ts`](../../backend/src/services/compiq/cardsight.client.ts):

| Endpoint | Function | Response shape | Used by today |
|----------|----------|----------------|---------------|
| `GET /catalog/search?q=...&type=card&segment=baseball&year=...&take=N` | `searchCatalog` | `CardsightCatalogResult[]`: `{id, name, number, releaseName, setName, year, player?}` | `findCompsViaCardsight`, `compsByPlayer`, `cardsight.mapper.resolveCardId` |
| `GET /catalog/cards/{cardId}` | `getCardDetail` | `CardsightCardDetail`: `{id, name, number, releaseName, setName, year, parallels: CardsightParallel[]}` | `cardsight.mapper` for disambiguation |
| `GET /pricing/{cardId}?parallel_id=...` | `getPricing` | `CardsightPricingResponse`: `{card?, raw: {records}, graded: [companies], meta: {last_sale_date}}` | `findCompsViaCardsight`, `compsByPlayer`, `getCardSalesRouted` |

Authentication: single `X-API-Key` header. No per-endpoint scope.

### Data-model facts that drive sibling-discovery design

1. **A "card" in Cardsight = a unique (year, release, set, number) tuple.**
   Each card has ONE `card_id`.
2. **Parallels are nested children of a single card_id**, NOT separate sibling
   card_ids. Refractor / Blue / Gold all share the same card_id, distinguished
   only by `parallel_id` on the pricing endpoint.
3. **`CardsightCatalogResult.player`** is **optional** and inconsistently
   populated. Yesterday's smoke confirmed this (Bonemer/Ohtani/Griffey all
   returned `undefined`). NOT a reliable filter field.
4. **`releaseName` = product line** ("Bowman Chrome Update", "Topps Update");
   **`setName` = subset within release** ("Base Set", "Chrome Prospect
   Autographs"). These are NOT interchangeable; `setName` is finer-grained.
5. **The `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary** at
   [`cardsight.mapper.ts:51-66`](../../backend/src/services/compiq/cardsight.mapper.ts#L51-L66)
   is the canonical translation from HobbyIQ product strings ("bowman
   chrome") to Cardsight `releaseName` values ("Bowman Chrome"). 9 entries
   live; missing entries logged but tolerated.

### Internal documentation found

- `docs/phase0/cardsight_sold_comp_capability.md` (2026-05-22) — confirms
  `/pricing/{cardId}` returns sold-comp records identical in fields to the
  pre-existing CardHedge shape.
- `docs/phase0/cardsight_coverage_characterization.md` (2026-05-22) —
  characterizes 4 consumption-layer defects in `cardsight.mapper` and
  `cardQueryParser`. 30-day production coverage was 1.6% `ok` rate, all
  root-caused to dictionary gaps + relevance ranking issues, NOT vendor
  data gaps.
- `docs/phase0/mcp_rewire_design.md` — the design behind
  `compsByPlayer.service.ts`.

No external Cardsight API documentation URL is referenced in the repo. The
above internal docs + the production code in `cardsight.client.ts` are the
authoritative API contract.

## 2. Why current `fetchSiblingSales` fails — root cause

[`fetchSiblingSales`](../../backend/src/services/compiq/compiqEstimate.service.ts) (introduced in B.4.c) uses:

- **Search query**: `${year} ${set} ${player}` (CardHedge-era token ordering)
- **Filter logic**:
  ```
  s.player === playerLc
    AND s.set === setLc
    AND s.year === yearLc
    AND s.card_id !== exactCardId
  ```

Against Cardsight's actual response shape:

- `s.player` is usually `undefined` → first AND-clause drops everything
- `s.set` returns the SUBSET name ("Base Set"), not the user's product line
  ("Bowman Chrome") → wouldn't match anyway
- No use of the `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary → "Bowman Chrome"
  isn't normalized to its Cardsight `releaseName`

**Conclusion**: the filter logic is **structurally incompatible** with
Cardsight's data model. This is not a tuning issue. The B.4.c implementation
was built on CardHedge-era assumptions (player attribution on catalog cards,
set field = product line) that don't hold under the Cardsight migration.

Yesterday's B.7 telemetry confirmed empirically: `siblings=0 poolSales=0`
for all four cards smoked (Ohtani, Bonemer, Griffey, Torres) on production.

## 3. Available paths forward

### Approach A — Wrap `fetchCompsByPlayer` with exact-card exclusion

**Mechanism**: Replace `fetchSiblingSales` internals with a call to
`fetchCompsByPlayer({playerName, product, cardYear, ...})`, then filter
out the exact card_id from the returned `cardIds`/`comps`.

**Endpoints used**: `searchCatalog` + `getPricing` (same as today, no new
endpoints).

**Effort**: ~1-2h composition + ~30-60min tests + smoke.

**Tradeoffs**:

- ✅ Reuses proven, cached, production-tested infrastructure
- ✅ Inherits `lookupReleaseName` dictionary + chrome fallback
- ✅ Inherits 6h aggregate cache (faster repeat queries)
- ✅ Resolves the `/price-by-id` fallback edge case automatically
  (caller passes structured fields directly via the function signature)
- ⚠️ Creates a dependency from `compiqEstimate` → `compsByPlayer`
  (acceptable; same service layer)
- ⚠️ Max 8 candidates per query; players with many cards in a product
  line (e.g., multiple subsets) won't all be enumerated. Probably fine —
  TrendIQ's segment is the player+product median, not per-subset
  enumeration.
- ⚠️ Products not in the dictionary degrade to "search by literal product
  string" with a warning. Same degradation as elsewhere in the system;
  same fix surface (dictionary expansion under CF-CARDSIGHT-COVERAGE).

### Approach B — Use `getCardDetail` to enumerate parallels of THIS card_id

**Mechanism**: Call `getCardDetail(cardId)` → `parallels[]`. For each
parallel, call `getPricing(cardId, parallelId)`. Aggregate.

**Endpoints used**: `getCardDetail` + `getPricing` (with `parallel_id`).

**Effort**: ~3h including new code paths.

**Tradeoffs**:

- ✅ Most precise — literally the same player+year+release+number,
  different parallel only
- ✅ No dictionary dependency (no `releaseName` translation needed)
- ⚠️ **Different segment semantics** from the locked design. The B.2
  design said "same player + year + set" — implicitly "same product,
  different card number." Approach B narrows to "same card, different
  parallel."
- ⚠️ Pool size depends on parallel count. Cards with many parallels
  (5+) work well; cards with only a base parallel produce null Layer 3.
- ⚠️ Doesn't capture broader product-line momentum, only parallel-
  level momentum within the resolved card.

### Approach C — Hybrid (A then B fallback)

**Mechanism**: Try Approach A first; if `cardIds` count is sparse,
fall back to Approach B's parallel enumeration on the resolved card.

**Effort**: ~3-4h.

**Tradeoff**: Best of both, but premature complexity for V1. Worth
revisiting after production data tells us whether Approach A's pool
sizes are adequate.

### Approach D — Status quo

**Mechanism**: Leave Layer 3 dormant. Composite stays effective
two-layer (player momentum + card trajectory) in production.

**Effort**: 0h.

**Tradeoff**: The "rare card" use case Layer 3 was specifically
designed for stays unaddressed. Not a regression (we shipped B.4.c
with Layer 3 explicitly Cardsight-blocked); just doesn't progress
toward the design's full vision.

## 4. Recommended approach

**Approach A.** Wrap `fetchCompsByPlayer` + exact-card-id exclusion.

### Why Approach A over B

- **Methodology alignment**: The locked design's "same player + year + set"
  naturally maps to Cardsight's "player + release" via the dictionary.
  Approach B's "same card, different parallel" is a different segment
  definition that would require methodology revision.
- **Broader pool capture**: For low-pop cards (the explicit "rare card"
  use case), pulling across multiple cardIds in the same product line is
  more likely to yield enough samples for the pre/post-anchor windows
  than enumerating parallels of one specific card.
- **Approach B fits as V2 refinement**: capturing parallel-level momentum
  on top of product-level momentum is a quality refinement worth
  considering once Approach A is in production.

### Why Approach A over C

- C is premature complexity. We don't yet have production data on whether
  Approach A's pool sizes are adequate — adding a fallback layer before
  observing the failure mode is speculative engineering.
- If production observation reveals sparse pools in real workloads, C
  becomes a justified V2 refinement.

### Why Approach A over D

- D leaves the explicit "rare card" design goal unfulfilled. Approach A's
  ~1-2h cost is low relative to the strategic value of unblocking Layer 3.
- D also leaves the `/price-by-id` fallback gap (surfaced in B.7
  telemetry) unaddressed indefinitely.

### Implementation scope (locked for the eventual workstream)

- **~1-2h composition**: replace `fetchSiblingSales` body with a call to
  `fetchCompsByPlayer`, map the response back to the `SiblingSalesPool`
  shape, filter out the exact card_id from both `cardIds` and `sales`.
  Caller signature unchanged.
- **~30-60min tests**: extend `compiqEstimate` integration tests or
  add a dedicated `fetchSiblingSales.test.ts` covering: pool returns
  non-empty for known tracked cards; exact card excluded; structured
  field fallback flows through `fetchCompsByPlayer`.
- **Smoke verification**: same Ohtani/Bonemer/Judge/Griffey/Torres
  matrix from B.4.c.3 — expectation is now `coverage="full"` for
  tracked cards with sufficient sibling data.

### Known tradeoffs accepted

- **8-candidate cap** on the pricing fanout. If a player's product line
  has more than 8 distinct cards (rare but possible for veterans with
  many subsets), some will be silently dropped from the segment pool.
  Acceptable for V1.
- **Dictionary-dependent products**. Products not in
  `COMPIQ_TO_CARDSIGHT_RELEASES` degrade to literal-string search.
  Out-of-dictionary case is logged. Dictionary expansion is a separate
  workstream (CF-CARDSIGHT-COVERAGE).
- **Max-pool sizing** is governed by `searchCatalog`'s `take=25` +
  `MAX_PRICING_PROBES=8`. Same caps as everywhere else in the system.

### V2 refinement candidate

If production data shows Approach A's pools are sparse for genuinely
rare cards (the segment is meant to fill in exactly there), consider:

- **Approach A → B hybrid**: when Approach A returns < N candidates,
  fall back to parallel enumeration via `getCardDetail` on the
  resolved card_id. Captures parallel-level momentum as a backstop.
- **Dictionary expansion**: missing products that show up in production
  warnings get added to `COMPIQ_TO_CARDSIGHT_RELEASES`.

Defer both until B.7-equivalent telemetry on the Approach A
implementation surfaces the actual failure modes.

## 5. If no viable path had existed

"No viable path" was a real possibility at the investigation's start.
The CF was framed as "unknown scope" precisely because the data-model
mismatch surfaced in B.4.c.3 looked structural and we didn't yet know
whether Cardsight exposed adequate alternatives.

The finding that retired this concern was discovering
`compsByPlayer.service.ts` — a working production service that already
solves the catalog-search → filter → top-K probe → aggregate problem
for an adjacent use case (MCP `/predict` rewire). Its existence collapses
"build a new sibling-discovery mechanism from scratch" into "compose
existing services" — a fundamentally different scope.

Had `compsByPlayer.service.ts` not existed, the realistic alternatives
would have been:

- **Methodology revision**: redefine "segment" to match Cardsight's
  natural grouping (e.g., per-release rather than per-product-line),
  amend the trendiq_design.md spec, then implement against that.
- **Live API probing for unknown endpoints**: I.2 sub-phase would have
  become mandatory rather than skippable. Probing for player-id lookup
  endpoints, catalog enumeration patterns, etc., to find what Cardsight
  actually supports at the API surface.
- **Defer Layer 3 indefinitely**: ship two-layer TrendIQ in V1 and
  revisit segment trajectory in V2 once a different data source or
  Cardsight API evolution made it viable.

None of these are necessary now. They're documented here as the
counterfactual investigation outcomes.

## 6. Resolution of secondary /price-by-id fallback gap

Yesterday's B.7 production telemetry surfaced a secondary gap:
`/price-by-id`'s minimal-body path (`{cardHedgeCardId, query?, ...}`)
bypasses the parsedQuery fallback added in B.4.c, because the body
doesn't carry `product` or `cardYear`. Production traces showed
`fallback.set=undefined fallback.year=undefined` on real iOS traffic
hitting that endpoint.

**Approach A resolves this automatically.** `fetchCompsByPlayer`
accepts structured fields directly via its function signature:

```ts
fetchCompsByPlayer({
  playerName: string,
  product: string,
  cardYear?: number,
  parallel?: string,
  gradeCompany?: string,
  gradeValue?: string | number,
})
```

It does NOT depend on the cardIdentity-completeness assumption that
the original `fetchSiblingSales` relied on. The caller passes
`product` and `cardYear` directly — derivable from `queryContext`
upstream of `computeEstimate`, which carries `parseCardQuery` results
on all endpoint paths (including `/price-by-id`'s defensive parse via
`needsParseFallback`).

**Single workstream closes both gaps.** CF-CARDSIGHT-SIBLING-DISCOVERY
implementation will resolve:

- The **primary** Layer 3 blocker (structural data-model incompatibility)
- The **secondary** `/price-by-id` fallback edge case (folded in
  automatically by Approach A's signature)

No separate CF needed for the `/price-by-id` issue.

## Revised CF scope

- **Original CF estimate**: 3-6 hours research + implementation
- **Revised estimate**: ~2-3 hours total
  - Research: complete (this doc)
  - Implementation: ~1-2h composition
  - Tests: ~30-60min
  - Smoke verification: ~15-30min
- **Risk**: low — composition over working infrastructure, not invention.
