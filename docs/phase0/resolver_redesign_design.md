# CF-CARDSIGHT-RESOLVER-REDESIGN — Phase 1 Design (Revision 2)

**Date:** 2026-05-27
**Status:** Design phase. Read-only investigation; no code changes.
**Consumes:** [phase0/cardsight_schema_truth.md](cardsight_schema_truth.md)
**Authorization gate:** implementation requires separate user approval after design lock.

**Revision 2 (2026-05-27 PM late):** added specificity guard via exclusion match using sibling parallels (Drew's launch-grade pushback). Refactored title-match insertion point from `_getPricing` (HTTP client) to router-layer pure helper that consumes already-fetched detail.parallels[]. Stress-tested against Trout 2021 Topps Chrome's 23-parallel catalog entry.

## 1. Problem & strategic framing

`/pricing/{cardId}?parallel_id=X` returns empty for at least the Maddux Tiffany case (`raw=0, graded=[]`) despite the unified `/pricing/{cardId}` returning 156 raw + 59 PSA 10 records with clear Tiffany titles (`$1599 GREG MADDUX 1987 Topps Traded Tiffany PSA 10`). Cardsight's sales-tagging pipeline doesn't tag historical eBay listings with the `parallelId` for Tiffany even though the catalog `parallels[]` metadata exists.

Per-parallel hardcoded title patterns is the dictionary problem again — doesn't scale. Generalized catalog-driven matching scales because it uses each card's own parallels[] list + user's parallel input rather than hardcoded patterns.

Target architecture (already partially in place):

```
1. resolveCardId        → cardId, parallelId (or null)
2. getPricing(parallelId) → records (Blue Refractor case works here)
3. If filter empty + user specified a parallel:
       → retry getPricing without parallel_id (already shipped 3b55b8f)
       → THIS DESIGN: also title-filter the unified bucket by user's parallel tokens
4. Translator → grade-aware comp pool from filtered records
```

## 2. Data flow — Option α with integrity gate (RECOMMENDED)

### Trace of current flow

`resolveCardId` (cardsight.mapper.ts:247-525) returns `{ cardId, parallelId, warnings }`. parallelId is set if `resolveParallelOnCandidate` (line 527-572) found a matching parallel in `detail.parallels[]` via `parallelMatches(input.parallel, p.name)` — strict-set-equality with wrapper-strip (commit 4effbf4).

Then findCompsRouted (cardsight.router.ts:172-186) calls:
```ts
const [pricing, detail] = await Promise.all([
  getPricing(mapped.cardId, { parallelId: mapped.parallelId ?? undefined }),
  getCardDetail(mapped.cardId),
]);
```

**Detail probe IS already in the flow.** It runs in parallel with getPricing. Free data — no extra latency.

### Option α — use user's input tokens (RECOMMENDED)

Pros:
- Self-contained: title-matching tokens are `tokenizeParallel(userInputParallel)` — same wrapper-strip used by `parallelMatches`. No extra API dependency for the title-match itself.
- Symmetric with current parallel matching: same tokenizer drives both the parallelId resolution AND the title-match. Single source of truth for "what tokens represent this parallel".
- Token-set equivalence: user "TIFFANY" → `["tiffany"]`. Cardsight "Limited Edition (Tiffany)" → wrapper-strip → `["tiffany"]`. Same result.

Cons:
- If user types garbage ("xyz"), title-filter on `["xyz"]` returns 0 records → false-empty.

### Option β — use Cardsight's canonical parallel name

Pros:
- Authoritative tokens from Cardsight's parallels[].
- Validates the parallel exists in Cardsight before filtering.

Cons:
- Identical token set in all practical cases due to wrapper-strip symmetry.
- No new information — adds dependency without benefit.

### Decision: Option α + integrity gate

Only fire title-matching when:
1. User specified a `parallel` input string
2. `resolveParallelOnCandidate` returned a non-null `parallelId` (i.e., the user's parallel matched a real Cardsight parallel)
3. `getPricing` with `parallel_id` filter returned empty (raw count 0 AND graded array empty/zero records)
4. The unified (retry-without-filter) response has at least 1 record

Conditions 1-2 are the validation: we only title-filter when we KNOW the parallel exists in Cardsight. Garbage user input gets parallelId=null → title-matching never fires.

## 3. Title-match precision design

### 3a. Specificity guard via exclusion (LAUNCH-GRADE — Drew's pushback)

**Problem:** strict ALL-tokens match alone fails for generic parallels. If user input "Refractor" tokenizes to `["refractor"]` and Cardsight doesn't tag the base Refractor sales, the unified bucket has 134 records spread across Refractor + 22 colored refractor siblings. Match on `["refractor"]` over-pulls every Blue/Gold/Aqua/etc. Refractor sale because "refractor" is a substring of all their titles.

The integrity gate (parallelId resolved) does NOT prevent this — the generic parallel exists in catalog, may be untagged in sales, has a generic token. Strict match without exclusion is a launch hazard.

**Guard:** when about to title-match for parallel P on a card:

1. Tokenize P (wrapper-stripped) — `userTokens`
2. Get the card's `detail.parallels[]` (already fetched in router at [cardsight.router.ts:172-181](../../backend/src/services/compiq/cardsight.router.ts#L172-L181) — free data)
3. For each sibling S in `parallels[]` (excluding P itself by id), tokenize S → `siblingTokens`
4. If `userTokens` is a **proper subset** of any `siblingTokens` (S has all of userTokens AND more), P is "generic relative to siblings"
5. Compute `distinguishingTokens` = union of (siblingTokens \ userTokens) across all such siblings
6. Match condition becomes: title contains ALL `userTokens` AND title contains NONE of `distinguishingTokens`

If `userTokens` is NOT a subset of any sibling (distinctive, like "tiffany"), strict ALL-tokens match unchanged.

### 3b. Match logic worked examples

For Maddux 1987 Topps Traded (`parallels=[Limited Edition (Tiffany)]`):

| User input | userTokens | Subset of any OTHER sibling? | Match logic |
|---|---|---|---|
| "Tiffany" | `["tiffany"]` | NO (only sibling IS the target — match by parallelId, not subset check against itself) | Strict: title contains "tiffany" |

For Trout 2021 Topps Chrome (23 parallels including base "Refractor", colored refractors, "Superfractor"):

| User input | userTokens | Subset of any sibling? | distinguishingTokens | Match logic |
|---|---|---|---|---|
| "Refractor" | `["refractor"]` | YES — subset of "Blue Refractor", "Gold Refractor", "Blue Wave Refractor", etc. | `{blue, gold, green, aqua, magenta, orange, pink, purple, red, sepia, wave, super, prism, mini, diamond, printing, plates, negative, black, white}` | title has "refractor" AND none of those |
| "Blue Refractor" | `["blue", "refractor"]` | YES — subset of "Blue Wave Refractor" | `{wave}` | title has "blue" + "refractor" AND not "wave" |
| "Blue Wave Refractor" | `["blue", "wave", "refractor"]` | NO (no sibling has all 3) | (none) | Strict: title contains all 3 |
| "Superfractor" | `["superfractor"]` | NO | (none) | Strict: title contains "superfractor" |
| "Pink Refractor" | `["pink", "refractor"]` | NO (no Pink-wave sibling) | (none) | Strict |

The exclusion guard delivers:
- Refractor base-only matching even when Cardsight doesn't tag the base
- Blue Refractor matching that correctly excludes Blue Wave Refractor titles
- Distinctive parallels (Tiffany, Superfractor) bypass the guard entirely

### 3c. Stress test against Trout 2021 Topps Chrome's 23 parallels

Per schema doc, Trout 2021 has `parallels[]`:

```text
Aqua Refractor /199         Magenta Refractor /399
Aqua Wave Refractor /199    Magenta Speckle Refractor /350
Black & White Mini Diamond  Negative Black & White Refractor
Blue Refractor /150         Orange Refractor /25
Blue Wave Refractor /75     Orange Wave Refractor /25
Gold Refractor /50          Pink Refractor
Gold Wave Refractor /50     Printing Plates /4
Green Refractor /99         Prism Refractor
Green Wave Refractor /99    Purple Refractor /299
Refractor                   Red Refractor /5
Sepia Refractor             Red Wave Refractor /5
SuperFractor /1
```

Spot checks against the guard logic:

| User input | Guard fires? | Expected match behavior |
|---|---|---|
| "Refractor" | YES (subset of nearly all siblings) | Match titles with "refractor" excluding {blue, gold, green, aqua, magenta, orange, pink, purple, red, sepia, wave, super, prism, mini, diamond, printing, plates, negative, black, white}. Result: ONLY base Refractor sales pass. ✓ |
| "Blue Refractor" | YES (subset of "Blue Wave Refractor") | Match titles with "blue" + "refractor" excluding "wave". Blue Refractor passes ✓, Blue Wave excluded ✓ |
| "Gold Refractor" | YES (subset of "Gold Wave Refractor") | Match "gold" + "refractor" excluding "wave". ✓ |
| "Blue Wave Refractor" | NO (no sibling is super-set) | Strict: title has "blue" + "wave" + "refractor". ✓ |
| "Aqua Wave Refractor" | NO | Strict: title has all 3. ✓ |
| "SuperFractor" | NO | Strict: title has "superfractor". ✓ |
| "Mini Diamond" | NO | Strict: title has "mini" + "diamond". ✓ |
| "Printing Plates" | NO | Strict: title has "printing" + "plates". ✓ |

No over-pull case identified. Distinctive parallels (Tiffany, Superfractor, Mini Diamond) match strict; generic ones (Refractor, single-color refractors) get the exclusion guard.

### 3d. False-positive edge cases (acknowledged + accepted for v1)

The guard is not perfect. Acknowledged residual risks:

- **Cross-sibling title contamination by sellers:** if a seller titles a Blue Refractor as "BLUE WAVE REFRACTOR LOOK!" (Wave as descriptor, not parallel), the exclusion guard would (correctly per token semantics) exclude it from Blue Refractor matches. Conservative — we under-pull on bad titles, don't over-pull.
- **Inter-card collision:** distinguishing tokens are computed per-card from that card's siblings only. A parallel name from a different card's siblings doesn't affect the match. ✓
- **Generic tokens that aren't subsets (rare):** e.g., a card with only one "Gold" parallel and no "Gold Refractor" sibling — guard doesn't fire, strict match on `["gold"]` could pull in "Gold Glove" or "Gold Medal" descriptors. Empirically not observed in cohort; surface as follow-up if a real case appears.

### 3d-prime. False-NEGATIVE tradeoff (the cost of choosing exclusion over over-pull)

The exclusion guard trades over-pull (over-inclusion of sibling-parallel sales — false positives) for potential under-pull (exclusion of legitimate base-parallel sales whose titles happen to contain a distinguishing token — false negatives).

**Concrete example:** a legitimate base "Refractor" Mike Trout sale titled "2021 Topps Chrome Refractor Mike Trout BLUE jersey worn #27" — the word "blue" describes the jersey/photo, not a parallel. The exclusion guard sees sibling-distinguishing-token "blue" in the title and drops this legitimate base Refractor sale from the comp pool.

**Result:** false negative. The filtered sample is smaller than the true population. Remaining sales are still honest base Refractor, so the price stays correct — it's just computed from a smaller honest sample rather than a larger contaminated one.

**Why accepted for v1:**

- **Under-inclusion (smaller honest sample) beats over-inclusion (polluted price).** Drew's launch-grade pushback on the original "no specificity threshold" was specifically about over-pull contamination; tolerating some under-pull is the trade.
- **Incidental distinguishing-token mentions are empirically rarer than systematic sibling-parallel over-pull.** A title mentioning "BLUE jersey" in a base Refractor listing is a long-tail seller-language pattern; titles correctly containing "Blue Refractor" for actual Blue Refractor sales are the common pattern.
- **lowSample priceSource flag provides the safety signal.** If false-negatives shrink filtered N below 3, the response shape carries `title-match-low-sample` → iOS surfaces a confidence disclosure. Users see honest pricing with low-sample caveat rather than a confidently-wrong polluted average.
- **The base "Refractor" case where this matters most likely won't hit title-matching at all** because Cardsight tags base Refractor sales (parallel_id filter delivers). Title-matching fires only when parallel_id returns empty, which for generic parallels suggests something unusual about that card's catalog state — a context where smaller honest samples are appropriate.

**Future refinement: CF-TITLE-MATCH-EXCLUSION-REFINEMENT** (gated on production evidence of excessive false-negatives):
- Positional token analysis (distinguishing token only counts when adjacent to parallel keyword)
- Per-sibling print-run signal as additional discriminator (e.g., "/150" appears for Blue Refractor sales but not in base Refractor titles)
- Statistical approach: if filtered sample drops by > some threshold relative to unified, suspect false-negative pollution

**Don't build the refinement now. Document the tradeoff, ship v1, measure.**

### 3e. Match strength: strict ALL tokens (within the guarded match condition)

After the specificity guard computes the effective match condition, the condition itself is strict — ALL `userTokens` must appear in title, ALL `distinguishingTokens` (if any) must be absent. Case-insensitive substring matching.

### 3f. Sample-size handling

After title-filtering, behavior depends on filtered record count `N`:

| N | Behavior |
|---|---|
| N ≥ 3 | Use filtered set as comp pool. Confidence: normal. Attribution tag: `title-matched-parallel` |
| N = 1-2 | Use filtered set. Confidence flag: `low-sample`. Attribution still `title-matched-parallel` but with `lowSample: true` |
| N = 0 | Fall back to unified bucket (current 3b55b8f behavior). Log + warning surfaced. |

Rationale: filtered N=0 means our title-matching pattern doesn't match any title in the unified bucket — likely the user's parallel doesn't actually appear in sale titles (e.g., sellers describing in detail but not title). Unified bucket is the best-effort fallback.

### 3g. Attribution — 7 internal priceSource values, 3 user-facing categories

The pricing flow tags every response with a `priceSource` indicating how the comp pool was derived. The internal enum has 7 fine-grained values (for telemetry + debugging). The `/api/compiq/estimate` response collapses to 3 stable user-facing categories so iOS handles a stable contract that doesn't churn when we add/refine internal values.

**Internal enum (telemetry, server logs, structured prediction events):**

| Internal value | Meaning |
|---|---|
| `cardsight-parallel-id` | Cardsight's parallel_id filter delivered records |
| `title-matched-parallel` | Our title-matching filtered the unified bucket; N ≥ 3 |
| `title-match-low-sample` | Title-matched, but filtered N is 1-2 |
| `unified-fallback-generic` | Reserved — was the suppress-path; with exclusion guard, this value is RESERVED (not currently emitted) |
| `unified-fallback-no-match` | Title-match produced N=0; fell back to unified bucket |
| `unified-no-parallel` | User didn't specify a parallel |
| `unified-no-cardsight-match` | User parallel didn't match any Cardsight sibling (integrity-gate suppress) |

**User-facing collapse (response shape on `/api/compiq/estimate`):**

| User-facing category | Maps from internal values | Semantic |
|---|---|---|
| `exact` | `cardsight-parallel-id`, `title-matched-parallel` | Parallel-specific comp pool. Trust the price. |
| `approximate` | `title-match-low-sample`, `unified-fallback-generic` | Parallel-specific filter applied but sample is thin OR generic-token guard suppressed. Disclose confidence. |
| `broad` | `unified-fallback-no-match`, `unified-no-parallel`, `unified-no-cardsight-match` | Mixed comp pool across base + all parallels. Comp pool semantically broader than user's specified parallel. |

The collapse happens at the response-shaping layer (where `/api/compiq/estimate` response is assembled), not inside the helper. The helper emits the fine internal value; the response shape includes both:
- `priceSourceInternal` (debug-only, included for ops telemetry — not surfaced in iOS UI)
- `priceSource` (user-facing 3-category, what iOS reads)

**Why 7→3 collapse vs single enum:**

- iOS code paths only need 3 distinct render behaviors (trust / disclose-confidence / disclose-broader-pool). Building UI on a 7-value enum invites churn every time we refine internal semantics.
- Future internal value additions (e.g., a future `title-match-with-positional-guard` from CF-TITLE-MATCH-EXCLUSION-REFINEMENT) get mapped into one of the existing 3 user-facing categories without iOS rev.
- Telemetry/ops keep full granularity for debugging — the 7-value enum surfaces in App Insights traces + structured prediction events + ops/cardsight-probe diagnostic responses.

Also surfaced on response: `filteredCount` and `totalUnifiedCount` so iOS can show "N of M comps used" disclosure for `approximate` and `broad` categories.

## 4. Architecture insertion point

**Revision 2 decision:** title-match logic moves OUT of `_getPricing` (HTTP client) and into a pure helper called by the router. Rationale: the specificity guard needs `detail.parallels[]`, which is already fetched in parallel with `getPricing` at the router level. Pulling that data into `_getPricing` would either require duplicating the fetch or threading a structured-data parameter through the HTTP layer — both worse than keeping the HTTP client focused on transport and putting comp-pool filter semantics where they naturally belong.

### Layer separation

- **`cardsight.client._getPricing`:** unchanged from 3b55b8f. Tries `parallel_id` filter; retries unified when empty. Returns response. Tag whether fallback fired via a new optional `priceSource` field on the response shape OR a parallel return value.
- **`cardsight.router` (new helper `applyParallelTitleMatch`):** pure function. Inputs: unified response, user parallel tokens, sibling parallels[], matched parallelId. Outputs: filtered response + priceSource attribution.

### New helper sketch

```ts
export interface ParallelTitleMatchResult {
  response: CardsightPricingResponse;
  priceSource:
    | "cardsight-parallel-id"      // _getPricing's first-pass filter delivered
    | "title-matched-parallel"     // we title-filtered the unified bucket
    | "title-match-low-sample"     // title-matched but N < 3
    | "unified-fallback-generic"   // user parallel too generic AFTER guard (suppressed)
    | "unified-fallback-no-match"  // title-match produced N=0, fell back
    | "unified-no-parallel"        // user didn't specify a parallel
    | "unified-no-cardsight-match"; // user parallel didn't match any Cardsight sibling
  filteredCount: number;
  totalUnifiedCount: number;
}

export function applyParallelTitleMatch(input: {
  pricingResponse: CardsightPricingResponse;
  pricingCameFromUnifiedFallback: boolean;
  userParallelInput: string | null | undefined;
  matchedParallelId: string | null;
  matchedParallel: { id: string; name: string } | null;  // the sibling matched by parallelMatches
  siblingParallels: Array<{ id: string; name: string }>; // detail.parallels[]
}): ParallelTitleMatchResult { ... }
```

### Caller integration (router-level)

```ts
const [pricing, detail] = await Promise.all([
  getPricing(mapped.cardId, { parallelId: mapped.parallelId ?? undefined }),
  getCardDetail(mapped.cardId),
]);

const matchedParallel = mapped.parallelId && detail?.parallels
  ? detail.parallels.find((p) => p.id === mapped.parallelId) ?? null
  : null;

const titleMatchOutcome = applyParallelTitleMatch({
  pricingResponse: pricing,
  pricingCameFromUnifiedFallback: pricing.priceSource === "unified-fallback",
  userParallelInput: opts.queryContext?.parallel,
  matchedParallelId: mapped.parallelId,
  matchedParallel,
  siblingParallels: detail?.parallels ?? [],
});

const translated = translateResponse(titleMatchOutcome.response, {
  gradeCompany: opts.gradeCompany,
  gradeValue: opts.gradeValue,
});
```

The router then surfaces `titleMatchOutcome.priceSource` and `filteredCount`/`totalUnifiedCount` on `/api/compiq/estimate` response (per Q2 lock).

### Pure helper implementation sketch

```ts
function applyParallelTitleMatch(input): ParallelTitleMatchResult {
  // No user parallel → unified, no filter
  if (!input.userParallelInput?.trim()) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-no-parallel",
      filteredCount: countRecords(input.pricingResponse),
      totalUnifiedCount: countRecords(input.pricingResponse),
    };
  }

  // User parallel didn't match any Cardsight sibling → integrity-gate suppress
  if (!input.matchedParallelId || !input.matchedParallel) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-no-cardsight-match",
      filteredCount: countRecords(input.pricingResponse),
      totalUnifiedCount: countRecords(input.pricingResponse),
    };
  }

  // Cardsight's parallel_id filter delivered → no title-match needed
  if (!input.pricingCameFromUnifiedFallback) {
    return {
      response: input.pricingResponse,
      priceSource: "cardsight-parallel-id",
      filteredCount: countRecords(input.pricingResponse),
      totalUnifiedCount: countRecords(input.pricingResponse),
    };
  }

  // Title-match path: compute tokens + specificity guard
  const userTokens = tokenizeParallel(input.userParallelInput);
  if (userTokens.length === 0) {
    return { /* unified, unified-no-parallel */ };
  }

  const userTokenSet = new Set(userTokens);
  const otherSiblings = input.siblingParallels.filter((p) => p.id !== input.matchedParallelId);

  // Find siblings where userTokens is a proper subset (sibling has all of userTokens + more)
  const superSiblings = otherSiblings.filter((s) => {
    const sTokens = tokenizeParallel(s.name);
    return userTokens.every((t) => sTokens.includes(t)) && sTokens.length > userTokens.length;
  });

  // distinguishingTokens = union of (siblingTokens \ userTokens) across superSiblings
  const distinguishingTokens = new Set<string>();
  for (const s of superSiblings) {
    for (const t of tokenizeParallel(s.name)) {
      if (!userTokenSet.has(t)) distinguishingTokens.add(t);
    }
  }

  // Match function: title has ALL userTokens AND NONE of distinguishingTokens
  const matches = (title: string | undefined): boolean => {
    if (!title) return false;
    const lower = title.toLowerCase();
    if (!userTokens.every((t) => lower.includes(t))) return false;
    for (const dt of distinguishingTokens) {
      if (lower.includes(dt)) return false;
    }
    return true;
  };

  const filtered = filterPricingRecords(input.pricingResponse, matches);
  const filteredCount = countRecords(filtered);
  const totalUnifiedCount = countRecords(input.pricingResponse);

  if (filteredCount === 0) {
    return {
      response: input.pricingResponse,
      priceSource: "unified-fallback-no-match",
      filteredCount: 0,
      totalUnifiedCount,
    };
  }
  if (filteredCount < 3) {
    return {
      response: filtered,
      priceSource: "title-match-low-sample",
      filteredCount,
      totalUnifiedCount,
    };
  }
  return {
    response: filtered,
    priceSource: "title-matched-parallel",
    filteredCount,
    totalUnifiedCount,
  };
}
```

`tokenizeParallel` is exported from cardsight.mapper.ts — same tokenizer used by `parallelMatches`. Single source of truth.

`_getPricing` adds a single internal flag indicating whether the fallback fired (so the router can tell the difference between "parallel_id delivered" and "we fell back to unified"). Minimal client-side change.

## 5. Inert code removal plan

Per [cardsight_schema_truth.md §8](cardsight_schema_truth.md):

### Remove from cardsight.mapper.ts

1. **`TIFFANY_RELEASE_OVERRIDES` dictionary** (lines 87-145, 14 entries + extensive comment block). Dead code.
2. **`lookupReleaseName(product, parallel?, year?)` signature extension** — revert to `lookupReleaseName(product)`. The optional parameters never produce useful output because the override returns long-form setName that doesn't match Cardsight's actual setName. Single-arg form is sufficient.
3. **Call site updates:** `_resolveCardId` line 326-333 — revert to `lookupReleaseName(effectiveProduct)`. compsByPlayer.service.ts line 151-162 — same.
4. **Release-filter `releaseName OR setName` extension** (cardsight.mapper.ts:294-322 in current state). Revert to original `(r) => r.releaseName?.toLowerCase() === expectedRelease`. The setName branch never matches anything useful and adds noise to the diagnostic log.

### Remove from cardsight.mapper.test.ts

1. **"lookupReleaseName — Tiffany overrides (Phase 3)" describe block** (lines 941+, ~22 tests) — tests the dead dictionary.
2. **"resolveCardId — Tiffany integration (Phase 1 + Phase 3)" describe block** — integration test built on the inert combination.
3. **"resolveCardId — release-filter releaseName OR setName parity (Phase 1)" describe block** (lines 867-940, 4 tests) — tests the OR-extension.

### Keep

- **`tokenizeParallel` wrapper-strip** (cardsight.mapper.ts:279-301) — surviving correct work.
- **"resolveCardId — parallelMatches strips parenthesized wrappers (Tiffany case)" describe block** (lines 727-858, 5 tests) — surviving correct work.
- **All other mapper tests** — unrelated to inert work.

### Safety verification

Inert removal verified safe per schema doc §8. Backend test suite should run after removal — expect ~25-30 tests gone (the inert tests), full suite still passes.

Estimated test count post-removal: ~1090-1095 (from 1119, minus the ~25 dictionary + release-filter tests).

## 6. Test plan

### Inert removal tests (validation)

- All non-inert mapper tests still pass
- Backend test suite count drops by ~25-30 (the removed dictionary/release-filter tests)
- Drake Baldwin integration test still passes (relies on wrapper-strip, not dictionary)

### Title-matching tests (new helper unit tests + integration)

Pure-function tests on `applyParallelTitleMatch` (no HTTP, no mocking needed beyond fixtures):

| Case | Expected priceSource | Expected filteredCount |
|---|---|---|
| No user parallel input | `unified-no-parallel` | unchanged |
| User parallel but no matched parallelId (integrity gate fails) | `unified-no-cardsight-match` | unchanged |
| parallel_id filter delivered (no fallback flag) | `cardsight-parallel-id` | unchanged |
| Fallback fired, user = "Tiffany" (distinctive), unified has Tiffany titles | `title-matched-parallel` | N ≥ 3 |
| Fallback fired, user = "Tiffany", unified has only 2 Tiffany titles | `title-match-low-sample` | 1-2 |
| Fallback fired, user = "Tiffany", unified has NO Tiffany titles | `unified-fallback-no-match` | 0 |
| Fallback fired, user = "Refractor" on Trout-like 23-parallel card | `title-matched-parallel` with exclusion of `{blue, gold, wave, ...}` distinguishing tokens | base Refractor only |
| Fallback fired, user = "Blue Refractor", siblings include "Blue Wave Refractor" | `title-matched-parallel` excluding "wave" | Blue Refractor only |
| Fallback fired, user = "Blue Wave Refractor" (no super-set sibling) | `title-matched-parallel` strict | all 3 tokens present |
| Fallback fired, user = "Superfractor" (distinctive) | `title-matched-parallel` strict | "superfractor" titles only |

### Specificity guard stress test (against Trout 2021 Topps Chrome 23-parallel fixture)

Fixture: a `siblingParallels` list reproducing Trout 2021's 23 parallels from schema doc §3. Run guard for representative user inputs:

- "Refractor" → expect `superSiblings.length > 0`, `distinguishingTokens` includes wave + all colors + super
- "Blue Refractor" → expect 1 superSibling ("Blue Wave Refractor"), distinguishingTokens = {"wave"}
- "Blue Wave Refractor" → expect 0 superSiblings, no exclusion
- "Refractor Blue" → tokenization-order-independent, same as "Blue Refractor" (test sorted-equality semantics preserved)
- "Tiffany" → on Maddux 1-parallel fixture, expect 0 superSiblings (no candidate)

### Title-match-with-no-match fallback safety

Explicit test: when filtered records = 0, helper returns the ORIGINAL response unchanged (not an empty response). This is critical — otherwise a too-strict match collapses the comp pool to zero and we'd return source=no-recent-comps.

### Production verification

| Holding | Pre (today) | Expected post-title-match | Sample size |
|---|---:|---:|---:|
| Maddux Tiffany ×2 | $384 mixed | ~$1,200-1,400 Tiffany-only | ~5-15 (Tiffany subset of PSA 10) |
| Trout 2021 Topps Chrome | $44 (PSA 10) | $44 (unchanged — base, no parallel) | unchanged |
| Trout WMB | $697 (PSA 9) | $697 (unchanged — catalog gap, parallelId null) | unchanged |
| Griffey Jr | $184 (PSA 9) | $184 (unchanged — no Tiffany on these holdings per Cosmos) | unchanged |
| John Gil Gold | $27 (PSA 9) | depends on Cardsight parallel_id behavior for Gold | TBD |
| Bonemer Blue ×2 | $11 (PSA 9) | depends on Cardsight parallel_id behavior for Blue | TBD |

Expected production impact: 2 holdings (Maddux ×2) significantly change ($384 → $1200-1400). Others mostly unchanged unless their parallel_id filter was also empty.

## 7. Hard rules and HALT conditions

Per spec:
- HALT if title-matching requires detail probe per resolution (latency concern) — **NOT triggered** per data-flow analysis (Option α, detail probe already in flow but not REQUIRED for title-match)
- HALT if inert removal breaks tests (something depends on it) — verify via test run
- HALT if Maddux Tiffany post-fix still ~$384 (title-match not engaging) OR wildly off (FP pollution)
- HALT if title-matching produces suspiciously small samples across the board (match logic too strict)

Mid-phase HALT gates:
- After Phase 2 implementation, before Phase 3 deploy: tsc + tests clean
- After Phase 3 deploy, before commit: Maddux Tiffany verification

## 8. Implementation scope estimate (revised for specificity guard)

Split per Drew's Q3 lock — two separate commits, bisectable safety:

### Commit A: inert Phase 1 + Phase 3 removal (~50 LoC deleted, ~80 LoC test removal)

- Remove `TIFFANY_RELEASE_OVERRIDES` dictionary
- Revert `lookupReleaseName` signature to single-arg form
- Update 2 call sites (cardsight.mapper.ts:326-333, compsByPlayer.service.ts:151-162)
- Revert release-filter to `releaseName === expectedRelease` form (drop OR-setName branch)
- Remove tests: "lookupReleaseName — Tiffany overrides (Phase 3)" describe block + "release-filter releaseName OR setName parity (Phase 1)" describe block + the Phase 1+3 integration test
- Verification: backend suite count drops by ~25-30 tests; full suite still passes; **no production behavior change** (inert code was never engaging)

### Commit B: title-matching with specificity guard (~120 LoC added, ~110 LoC test additions)

- Export `tokenizeParallel` from cardsight.mapper.ts
- Add `priceSource` indicator to `_getPricing` response shape (small client-side change)
- New `applyParallelTitleMatch` pure function in cardsight.router.ts (or a new `parallelTitleMatch.ts` helper module)
- Integrate at router level after `Promise.all([getPricing, getCardDetail])`
- Surface `priceSource` + sample counts on `/api/compiq/estimate` response (per Q2 lock)
- Tests: ~10-12 new tests covering pure-function semantics + Trout 23-parallel stress test fixture

Estimated time: ~2.5-3h for implementation + tests + production verification (revised up from 1.5-2h to account for specificity guard logic + Trout stress test).

## 9. Follow-ups surfaced

If deferred from v1 implementation:

- **CF-CARDSIGHT-TITLE-MATCH-SPECIFICITY** — if false-positive cases surface (single-generic-token parallels matching unintended titles), add specificity heuristics or explicit guards.
- **CF-CARDSIGHT-PARALLEL-COVERAGE** (already on backlog) — vendor escalation for catalog gaps (Wal-Mart Border, etc.) and untagged-parallel-sales (Tiffany family). Outside this CF's scope; this CF works around the vendor gap rather than closing it.
- **Own-comp-pipeline** (roadmap Phase 4a) — the full-scale moat answer. Title-matching is a workaround until we own the ingestion + tagging layer.

## 10. Cross-references

- [cardsight_schema_truth.md](cardsight_schema_truth.md) — empirical schema reference this design consumes
- [cardsight.mapper.ts](../../backend/src/services/compiq/cardsight.mapper.ts) — resolveCardId + tokenizeParallel + inert code
- [cardsight.client.ts](../../backend/src/services/compiq/cardsight.client.ts) — getPricing + fallback (insertion point for title-match)
- [cardsight.router.ts](../../backend/src/services/compiq/cardsight.router.ts) — findCompsRouted caller
- [cardsight.translator.ts](../../backend/src/services/compiq/cardsight.translator.ts) — grade-aware filter
