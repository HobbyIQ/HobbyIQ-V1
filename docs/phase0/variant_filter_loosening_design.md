# CF-VARIANT-FILTER-LOOSENING — Design

**Date:** 2026-05-26
**Status:** Design phase. Read-only investigation; no code changes.
**Authorization gate:** implementation requires separate user approval after
design recommendation lands.

**Scope reminder:** Phase 1 below is analytical (per user approval) — it
maps each expected variant-mismatch holding to the `isCompVariantMatch`
rejection mode it will hit, grounded in code + the prior
[polluted_metadata_holdings_investigation](polluted_metadata_holdings_investigation.md)
cohort table. Empirical per-holding comp-count verification is deferred
to a pre-implementation sweep step.

---

## 1. Variant filter mechanics (recap, for grounding)

There are **two** independent rejection mechanisms in `computeEstimate`.
This design only loosens the first.

### 1a. Hard variant-mismatch guard (the one we're loosening)

[`compiqEstimate.service.ts:1370-1533`](../../backend/src/services/compiq/compiqEstimate.service.ts#L1370-L1533).

For every comp returned by Cardsight, run
[`isCompVariantMatch(compTitle, parsedForGuard)`](../../backend/src/services/compiq/cardQueryParser.ts#L303-L371).
`parsedForGuard` is built from `parseCardQuery(cardTitle)` then overridden
with `effectiveIsAuto` + `normalizedParallel` from the body
([line 1380-1384](../../backend/src/services/compiq/compiqEstimate.service.ts#L1380-L1384)).

Per-comp rejection reasons from `isCompVariantMatch`:

| Reason key | Trigger |
|---|---|
| `comp_missing_auto` | request `isAuto=true`, comp title lacks `auto` / `autograph(s/ed)` / `rpa` / card-number autograph prefix (CPA/BCPA/BPA/BCRRA/…) |
| `comp_has_unwanted_auto` | request `isAuto=false`, comp title contains an auto token |
| `parallel_mismatch:expected_<p>` | multi-word parallel not found in title; OR single-word parallel not found OR found-with-qualifier (`sky blue` when user wanted plain `blue`) |
| `parallel_qualifier_mismatch:expected_plain_<p>` | single-word parallel where qualified form precedes the user's plain form |
| `print_run_mismatch:expected_<n>` | `parsed.printRun` set but `/N` pattern not in comp title |
| `player_name_missing_from_comp` | last-name token not in comp title |

The short-circuit ("variant-mismatch") fires when **all** the following
hold simultaneously ([line 1407-1428](../../backend/src/services/compiq/compiqEstimate.service.ts#L1407-L1428)):

1. `recencyFilteredComps.length > 0` — Cardsight returned at least one comp
2. `variantFiltered.length === 0` — every comp was rejected by `isCompVariantMatch`
3. `parsedForGuard.isAuto || parsedForGuard.parallel` — the request had at least one variant attribute

OR a `variantWarning` token from `findCompsByQuery` itself flags an
auto/serial mismatch.

When this fires the response shape is `source: "variant-mismatch"`,
`fairMarketValue: null`, `compsUsed: 0`, with `recentComps` populated for
display but explicitly labeled mismatched.

### 1b. Soft post-filters (already loose; not part of this CF)

[`compiqEstimate.service.ts:1891-1932`](../../backend/src/services/compiq/compiqEstimate.service.ts#L1891-L1932)
implements `applyParallelFilter`, `applyAutoFilter`, `applyGradeFilter`
with **progressive fallback** — if the strict filter drops the pool
below 3 comps, fall back to the unfiltered pool. These never short-circuit
the response; they only narrow the pool that gets averaged.

These post-filters only run **after** the hard guard lets comps through.
If the hard guard rejects everything, the post-filters never see anything.

### 1c. Why sibling-rescue doesn't engage today

The sibling-rescue branch added in `cb9fe64`
(CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING) lives **inside** the
no-recent-comps short-circuit ([compiqEstimate.service.ts ~line 1620](../../backend/src/services/compiq/compiqEstimate.service.ts)),
not the variant-mismatch short-circuit. So when 6 holdings hit the hard
guard, they bypass sibling rescue entirely and return
`source: "variant-mismatch"`.

---

## 2. Phase 1 — Characterization of the 6 affected holdings (analytical)

### 2.1 Cohort identification

After `2400f94` (CF-AUTOPRICE-FIELD-NAME-SHIM) + `2f444f5`
(CF-PLAYERNAME-NORMALIZATION), the 13 iOS-real holdings have
shimmed `cardYear` + `product` and normalized `playerName`. Of those
13, six are expected to remain in `variant-mismatch` state:

| # | Cosmos ID prefix | Stored playerName | Normalized → | year | product | parallel | Expected isAuto |
|---|---|---|---|---:|---|---|---:|
| 1 | `8053921B…` | Caleb Bonemer | Caleb Bonemer | 2024 | Bowman Chrome | Blue | false |
| 2 | `6D217E3D…` | Caleb Bonemer | Caleb Bonemer | 2024 | Bowman Chrome | Blue | false |
| 3 | `391ED290…` | `PROSPECT AUTOGRAPHS JOHN GIL CHR PROS - MINI DIA` | `JOHN GIL` | 2025 | Bowman Chrome | Gold | true (via normalization) |
| 4 | `0E7AAE4D…` | `CHROME PROSPECT AUTOGRAPHS GAGE WOOD CHR PROSPECT - REF` | `GAGE WOOD` | 2025 | Bowman Draft | Gold | true |
| 5 | `EE9C49BD…` | `CHROME PROSPECT AUTOGRAPHS CALEB BONEMER CHR PROSPECT AU- SHIM` | `CALEB BONEMER` | 2024 | Bowman Draft | Gold | true |
| 6 | `30E4E5F2…` | `PROSPECT AUTOGRAPHS TOMMY WHITE CHR PROS -MINI DIAMOND` | `TOMMY WHITE` | 2025 | Bowman Chrome | (raw: `CHR PROS AUTO-MINI DIAMOND` — non-canonical) | true |

(Per polluted_metadata cohort table — Section 1 of that doc. `isAuto`
field is implicit on these via `parallelHasAutoToken` matching `auto`
in the original cardTitle/parallel, or via explicit body.isAuto from
iOS; the polluted_metadata investigation found `isAuto` was correctly
flagged on prospect-auto holdings even when other metadata was polluted.)

LEO DE VRIES (`7BCB0A21…`) is a partial-normalization case — the prefix
strip leaves `LEO DE VRIES PROSPECT AU- RAYWAVE` because
`PLAYERNAME_GENERIC_CODE_SUFFIX` (`\bCHR\s+PROS(?:PECT)?\b.*$/i`)
requires `CHR PROS`, not bare `PROSPECT AU-`. Whether this lands in
variant-mismatch or in `no-recent-comps` (Cardsight catalog miss)
depends on whether Cardsight's fuzzy match on the polluted name still
resolves a card_id. Empirical sweep would disambiguate.

### 2.2 Per-holding rejection-mode analysis

Mapping each holding to the `isCompVariantMatch` rejection it will hit:

#### Holding 1 & 2 — Caleb Bonemer 2024 Bowman Chrome Blue (base)

- `parsedForGuard.isAuto`: false
- `parsedForGuard.parallel`: `blue` (single-word)
- Expected Cardsight return: comps for the canonical Bonemer 2024 Bowman
  Chrome card_id. Bowman Chrome 2024 has a known parallel ladder including
  Blue, Sky Blue, Refractor, Gold, etc.
- Likely rejection reasons (per [`cardQueryParser.ts:333-352`](../../backend/src/services/compiq/cardQueryParser.ts#L333-L352)):
  - `parallel_mismatch:expected_blue` — any comp whose title lacks the
    word "blue" (e.g., base/refractor/gold/auto comps in the same
    card_id pool)
  - `parallel_qualifier_mismatch:expected_plain_blue` — Sky Blue / Royal
    Blue / Ice Blue parallels are explicitly rejected even though they
    contain "blue", because the single-word-parallel logic also strips
    qualifier-prefixed forms
- Why everything could get filtered out: this is a low-pop prospect base
  parallel; Cardsight may return primarily Sky Blue / Refractor / auto
  comps and very few or zero plain-Blue base comps. If all returned
  comps fall into rejected categories → empty filtered pool → guard
  trips.

#### Holding 3 — JOHN GIL 2025 Bowman Chrome Gold Auto

- `parsedForGuard.isAuto`: true
- `parsedForGuard.parallel`: `gold` (single-word)
- Expected catalog resolution: ambiguous — "JOHN GIL" is a truncated
  player surname (likely intended "John Gil Vargas" or similar). May
  resolve to a generic Chrome Prospect Auto card_id or fail catalog.
- Likely rejection reasons:
  - `comp_missing_auto` — base parallel comps in the pool that lack auto tokens
  - `parallel_mismatch:expected_gold` — non-Gold parallels
  - Likely double-stacked rejection: most pool comps fail both checks
- Why everything could get filtered out: 2025 Bowman Chrome prospect auto
  Gold is a numbered parallel (often /50) with thin sold history. The
  comp pool may be dominated by base prospect or non-Gold auto variants
  → all rejected.

#### Holding 4 — GAGE WOOD 2025 Bowman Draft Gold Auto

- Same rejection signature as Holding 3 (auto + single-word parallel,
  numbered low-pop variant).
- The Skenes example in the handoff (`66 comps fetched, all rejected for
  comp_missing_auto`) is the canonical instance of this failure mode.
  Cardsight returns comps for the prospect's broader card_id which
  includes base + paper + chrome non-auto variants; isAuto=true rejects
  them en masse.

#### Holding 5 — CALEB BONEMER 2024 Bowman Draft Gold Auto

- Same rejection signature as Holdings 3/4. The Bonemer "69 comps
  filtered to 0" pattern referenced in the SESSION_HANDOFF cardsight
  characterization doc is this same holding's behavior.

#### Holding 6 — TOMMY WHITE 2025 Bowman Chrome (parallel non-canonical)

- `parsedForGuard.parallel` derived from the stored value
  `CHR PROS AUTO-MINI DIAMOND`. `normalizeParallel` will likely return
  it as-is (or partially canonicalized) — this is a multi-token parallel
  string.
- If `normalizedParallel` ends up multi-word, isCompVariantMatch goes
  into the **specific** branch (`parallelLower.split(" ").length > 1`),
  which requires the full substring to appear in comp titles.
- Likely rejection: `parallel_mismatch:expected_chr_pros_auto-mini_diamond`
  — virtually no comp title contains that exact substring.

### 2.3 Failure-mode taxonomy across the 6 holdings

Reduced to three distinct failure modes:

| Mode | Affected | Description |
|---|---|---|
| **M1: auto + single-word parallel exclusion cascade** | 3, 4, 5 (prospect auto Gold) | Cardsight returns broad card_id comp pool. Most comps lack auto OR lack the specific color. Strict double-check (`isAuto` AND `parallel`) filters everything. |
| **M2: single-word color over-strict** | 1, 2 (Bonemer Blue base) | Single-word parallel rejects every comp that's a sibling parallel (Sky Blue, Refractor, Gold). Bonemer Blue is low-pop; few plain-Blue comps survive. |
| **M3: malformed parallel string** | 6 (Tommy White) | Stored parallel is variant catalog text, not a canonical parallel name. Multi-word strict match never finds it in titles. |

### 2.4 Common thread

For all six: the variant filter is doing exactly what it was designed
to do — reject wrong-variant comps. The problem is the **fallback
semantics**: when the strict filter zeroes out the pool, there's no
graceful degradation. The user gets `source: "variant-mismatch"` and
`fairMarketValue: null` instead of a confidence-degraded estimate.

The post-filter pattern in 1b (progressive fallback to unfiltered pool
when strict match yields <3 comps) is **already in the codebase** —
it's just on the wrong side of the hard guard. The hard guard
short-circuits before any post-filter could kick in.

---

## 3. Phase 2 — Design options

Four options, surfaced from broad → narrow scope.

### Option A — Permissive matching (relax `isCompVariantMatch`)

**Approach:** loosen the per-comp predicate. Specific changes:

- **Auto check:** keep `comp_missing_auto` as hard rejection (autograph
  vs. base is a real price discontinuity), but expand the auto-token
  regex to catch more title shapes (e.g., `signed`, `signature`,
  `autographed by`, autograph card-number prefixes).
- **Single-word parallel:** keep the qualifier rejection
  (`sky blue` rejected for `blue`) — that's a real price difference —
  but loosen the bare-substring check to allow exact-word match
  anywhere in title, not just adjacent to color qualifiers.
- **Multi-word parallel:** allow last-token match as fallback when
  full-phrase doesn't appear (so "auto-mini diamond" can match comps
  containing "mini diamond").

**Pros:**
- Each comp is more likely to pass the per-comp predicate, reducing
  the chance the hard guard trips.
- Doesn't restructure the fallback flow.

**Cons:**
- Loosening per-comp predicates risks **false positives** — comps that
  shouldn't match start passing, polluting the FMV.
- Hard to tune without breaking edge cases. Each rule change is
  load-bearing for some other CF's correctness.
- Doesn't address M3 (malformed parallel string).
- Wide blast radius — every pricing call sees the loosened predicates.

### Option B — Attribute-tiered fallback (let the guard degrade gracefully)

**Approach:** when `everythingFilteredOut`, instead of short-circuiting
to `variant-mismatch`, **progressively re-relax** the variant criteria
and retry the filter in tiers. Stop at the first tier that yields ≥3
comps. Cap confidence by tier.

Concrete tier ladder:

| Tier | Filter | Confidence cap |
|---|---|---:|
| T0 (current strict) | full `isCompVariantMatch` | 95 |
| T1 | drop parallel check (keep auto + player) | 80 |
| T2 | drop parallel + auto check (keep player only) | 65 |
| T3 (matches sibling-pool semantics) | accept any comp from the resolved card_id | 55 |
| Fallback | current `variant-mismatch` short-circuit | 0 (no price) |

Each tier re-runs the filter loop with a relaxed predicate. The first
tier producing ≥3 comps is used for pricing, and the response surfaces
the tier label (`variantStrictness: "T1"`) and confidence cap.

**Pros:**
- Mirrors the **already-proven** pattern in
  `applyParallelFilter`/`applyAutoFilter`/`applyGradeFilter` (progressive
  fallback to unfiltered pool). Architecturally consistent.
- Confidence cap propagates downstream so the iOS UI can show
  "estimated — variant unverified, confidence 65".
- Naturally handles M1, M2, M3 without per-rule tuning.
- Keeps strict matching as the default — only degrades when forced.
- Tier label surfaces to the response → debuggable in production.

**Cons:**
- More code surface than Option A. New code path inside the hard guard.
- Need to define confidence-cap propagation (the existing pricing
  analytics block doesn't currently consume `variantStrictness`).
- T2/T3 risk shipping a misleading-but-near-FMV — needs verdict text
  cap ("estimated from broader variant pool — verify before listing").

### Option C — Sibling-pool semantics (route variant-mismatch through sibling rescue)

**Approach:** treat `everythingFilteredOut` as a thin-data signal and
route into the existing sibling-rescue branch from CF-AUTOPRICE-SIBLING-
DISCOVERY-WIRING. The sibling rescue fetches comps across sibling
parallels of the same prospect card and prices from that broader pool,
with a hardcoded 65 confidence cap.

**Pros:**
- **Reuses an already-shipped fallback path.** Minimal new code — mostly
  re-routing the `everythingFilteredOut` branch.
- Sibling-rescue already has a confidence cap and verdict-text lock
  ("Estimated from similar cards — variant unverified").
- Architectural symmetry: sibling-rescue handles "thin direct comps,
  broader sibling pool"; variant-mismatch is conceptually "wrong-variant
  direct comps, need a broader pool to price from".

**Cons:**
- Sibling-rescue uses `fetchSiblingSales` which queries by **player +
  product + year** (not by card_id). For M3 (Tommy White with malformed
  parallel) it should work; for M1/M2 (resolved card_id but rejected
  comps), the sibling-pool query would re-fetch comps Cardsight already
  returned, just under a different lookup. Possibly redundant work or
  same-pool circularity.
- Doesn't expose intermediate tiers (T1/T2). All-or-nothing: either
  strict variant match (compsUsed) or full sibling-pool fallback (65
  cap), no middle ground.
- The 65 cap is appropriate for sibling-pool semantics but may be too
  pessimistic for a holding where 80% of comps were rejected for one
  predicate (e.g., parallel) but auto + player matched perfectly.

### Option D — Data-quality fix (don't touch the filter; fix the inputs)

**Approach:** decline to modify the filter. Instead, address the
upstream root causes that make the filter trip:

- **For M1/M2:** ship CF-IOS-FIELD-CONTRACT-FIX +
  CF-PORTFOLIO-METADATA-BACKFILL so iOS sends correct field names; ship
  iOS playerName extraction so the contamination doesn't enter the
  database. Once iOS upgrades and old holdings are corrected, the
  filter's strictness becomes appropriate.
- **For M3:** add parallel canonicalization at the `addHolding`
  validation step so non-canonical parallel strings (`CHR PROS
  AUTO-MINI DIAMOND`) get rejected or normalized.

**Pros:**
- The filter is **correct as designed** — Phase 1 §2.4 acknowledges
  this. Loosening it risks introducing accuracy regressions for
  cards where the filter is currently catching real wrong-variant
  comps.
- Long-term-right solution: fix the data, not the matcher.

**Cons:**
- **Doesn't help today's 6 holdings.** They sit in `variant-mismatch`
  until the iOS contract fix lands AND the user re-enters or backfills
  the data.
- iOS contract fix is a 2-3h iOS workstream + iOS release cycle —
  weeks before users see the benefit.
- Scales poorly: every future variant-heavy holding will hit the same
  filter behavior. Today's 6 are the leading edge.

---

## 4. Phase 3 — Recommendation

**Recommend Option B — attribute-tiered fallback.**

Reasoning:

1. **Mirrors existing architecture.** The
   `applyParallelFilter`/`applyAutoFilter`/`applyGradeFilter` trio in
   the post-filter stage already implements progressive fallback to a
   broader pool with the ≥3-comp threshold. Moving the same idea
   one stage earlier (inside the hard guard) is architecturally
   consistent and reviewer-comprehensible.

2. **Handles all three failure modes (M1/M2/M3) without per-rule
   tuning.** Option A requires getting each loosened predicate right
   without breaking other CFs. Option B's confidence-tier approach is
   parametric — same code path adapts to whichever attribute was the
   blocker.

3. **Confidence cap is the right contract for the iOS UI.** The user
   gets a price, but with a visible "verify before listing"-style
   warning. Today they get nothing (`fairMarketValue: null`). T2/T3
   prices with `confidence ≤ 65` are strictly better than no price.

4. **Strictly safer than Option C.** Option C re-enters sibling-rescue
   for cases where Cardsight already returned comps. Option B prices
   from the comps that **were** returned (just with a relaxed
   predicate), avoiding redundant fetches and same-pool circularity.

5. **Doesn't block on iOS contract fix** (Option D's blocker). The 6
   affected holdings get pricing within hours of deploy.

6. **Reversible.** If T1/T2 prices prove noisy, the tier ladder can be
   trimmed (e.g., remove T2, leave T1 + T3 only) without restructuring.
   The strict-T0 default keeps high-quality cards unchanged.

**Implementation sketch (for separate authorization):**

- Refactor the variant-filter loop into a function that takes a
  `strictness: "T0" | "T1" | "T2" | "T3"` parameter and applies the
  appropriate subset of `isCompVariantMatch` rules.
- Replace the `everythingFilteredOut` short-circuit with a `for (const
  tier of TIERS)` loop, breaking at the first tier with ≥3 surviving
  comps.
- Plumb the chosen tier through to the response shape: add
  `variantStrictness` to compQuality + confidence-cap parameter to the
  pricing math.
- Keep `source: "variant-mismatch"` as the **fallback when T3 also
  yields <3 comps** (currently the always-on behavior).
- Add unit tests covering each tier transition + the fallback.
- Production sweep against the 6 holdings: verify how many promote
  from `variant-mismatch` → tiered live pricing, and at which tier.

Expected outcome:

| Holding | Likely tier | Predicted improvement |
|---|---|---|
| 1, 2 (Bonemer Blue) | T1 (drop parallel) | promotes to live, ~75-80 confidence |
| 3 (JOHN GIL Gold Auto) | T2 (drop parallel + auto) | promotes if pool has any prospect comps; otherwise T3 |
| 4 (Gage Wood Gold Auto) | T1 if auto pool exists; T2 otherwise | promotes; ~65-80 confidence |
| 5 (Bonemer Gold Auto) | T1 (drop parallel — auto pool exists) | promotes; ~80 confidence |
| 6 (Tommy White malformed) | T2 or T3 | promotes; ~55-65 confidence |

These predictions are analytical — empirical sweep at implementation
time will refine them.

---

## 5. Phase 4 — Open questions

1. **Confidence-cap mechanics.** The current pricing pipeline
   (`computeMechanism2/3/4` etc.) produces a `pricingConfidence` from
   compp count + recency + dispersion. How should `variantStrictness`
   compose with that? Multiplicative cap (`min(cap, computed)`)?
   Additive penalty? Replacement? Lock before implementation.

2. **iOS surfacing of tier label.** Today the UI shows "FMV: $X
   (confidence: Y)". For T1/T2/T3 results, should the verdict text
   include "Variant: unverified" / "Variant: closest match" annotation,
   or just rely on the confidence drop? Coordinate with iOS-side
   CF before implementation.

3. **T2 ↔ sibling-rescue interaction.** When T2 fires (drop parallel +
   auto), we're effectively pricing from the player's broader card_id
   pool — overlap with sibling-rescue semantics. Should T2/T3 actually
   call into `fetchSiblingSales` instead of re-using the originally
   fetched comps? Or is "use what we have, label it loosely" sufficient?

4. **`comp_has_unwanted_auto` direction.** Currently this is a hard
   rejection. For a base-card request that returns mostly auto comps,
   should the tier ladder also relax this direction? (E.g., if user
   has Bonemer Blue Base but pool is 90% Blue Auto, do we want to
   price it with an auto-discount or refuse?) Probably refuse — auto
   premium is severe — but worth surfacing.

5. **M3 root cause.** The Tommy White holding's parallel field
   (`CHR PROS AUTO-MINI DIAMOND`) is malformed and never canonical.
   Even with Option B, T2/T3 pricing for this holding will be a
   guesstimate. Should the design also include input-side parallel
   canonicalization as a separate phase? (Adjacent to Option D, but
   narrower.)

6. **Sweep methodology.** Do we run the post-impl sweep against the
   live `admin-testing-hobbyiq` cohort, or stand up a fixture set so
   the sweep is reproducible? Live data shifts as comps refresh; a
   fixture cohort is more pinnable for regression testing.

7. **Backtest impact.** The pricing accuracy backtest harness
   (`backend/scripts/backtest-pricing-accuracy.ts` or equivalent) needs
   to be re-run after Option B ships. T1/T2/T3 prices have unknown
   accuracy characteristics — they may improve aggregate MAPE (by
   pricing previously-null holdings) or hurt it (if loose prices are
   noisier than strict-match prices). Decision: include this as a
   gating verification before merge?

8. **`variantWarning`-driven critical short-circuit.** The hard guard
   has a second trigger (lines 1426-1427): `variantWarning` tokens from
   Cardsight matching `/(auto|autograph|signed|signature)/` or
   `/^\/\d/`. This isn't a `everythingFilteredOut` case — it's Cardsight
   self-reporting a variant mismatch. Should Option B's tier ladder
   also apply to this branch, or only to the `everythingFilteredOut`
   branch? Probably the former (consistency) but warrants explicit
   design lock.

---

## 6. Cross-references

- [polluted_metadata_holdings_investigation.md](polluted_metadata_holdings_investigation.md)
  — cohort table for the 13 iOS-real holdings (Section 1.4)
- [cardQueryParser.ts](../../backend/src/services/compiq/cardQueryParser.ts)
  — `isCompVariantMatch` (lines 303-371), `parseCardQuery`
- [compiqEstimate.service.ts](../../backend/src/services/compiq/compiqEstimate.service.ts)
  — variant-mismatch guard (lines 1370-1533), post-filters (lines 1891-1932),
  sibling-rescue branch (~line 1620)
- `2f444f5` — CF-PLAYERNAME-NORMALIZATION (normalizePlayerName helper)
- `2400f94` — CF-AUTOPRICE-FIELD-NAME-SHIM (shimmedCardYear/Product/Title)
- `cb9fe64` / `4b88fb5` — CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING
- SESSION_HANDOFF.md lines 66-90 — CF-VARIANT-FILTER-LOOSENING original
  surface + design questions
