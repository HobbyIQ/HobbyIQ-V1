# Card Hedge removal — v2 plan (post-rollback re-scope)

**Date:** 2026-05-22
**Inputs:**
- `docs/phase0/cardsight_coverage_characterization.md` (commit `9af3db2`)
- Addendum on Topps Update Base catalog inconsistency (commit `d31b2ff`)
- Original `docs/phase0/ch_removal_translator_design.md` (commit `c285c33`)
- `docs/SESSION_HANDOFF.md` 2026-05-22 entry (commit `b2006b9`)
- Reverts `566fd8e` (PR #111) and `83ea415` (PR #110) on `main`

**Status:** Planning doc. No code, no deploys. Each defect's fix is *characterized*, not implemented. Implementation is a follow-up workstream per phase.

## 1. Context and findings recap

The 2026-05-22 attempt rolled back two PRs (#110 backend meaningful-query fall-through, #111 MCP compsLoader rewire). The rollback closed both the broken iOS-shape query case and the partial-working WS2 full-text case. Subsequent diagnostic established that Cardsight is not the bottleneck — Cardsight has comprehensive vendor data (600+ records for demo cards, 100% hit rate across 10 test players in two cohorts). The 1.6% historical `outcome=ok / source=cardsight` rate in 30 days of production traffic is caused entirely by **five interacting defects in the consumption layer**.

The original `ch_removal_translator_design.md` reframe ("the fix is a routing change, not a new translator") is still correct — `resolveCardId` and `findCompsRouted` are the right architectural primitives. But those primitives have bugs. PR #110 made the routing change without addressing the bugs, so the routing change exposed the bugs to production traffic. **This v2 plan sequences defect fixes BEFORE re-attempting the routing change.**

## 2. The five defects

### Defect #1 — `resolveCardId` blind `candidates[0]` selection

**Location:** [cardsight.mapper.ts:144-156](../../backend/src/services/compiq/cardsight.mapper.ts#L144-L156)

**Current behavior:** After Cardsight catalog returns N candidates (filtered by `releaseName` when the dictionary maps the product), the function picks `candidates[0]` as the resolved cardId, regardless of whether that cardId carries pricing data or whether subsequent candidates are better matches.

**Required behavior:** Score candidates by (a) `releaseName` exact match against expected, (b) `setName` match against expected sub-pattern, (c) — critically — whether the cardId is data-bearing per a `getPricing` probe or an equivalent signal. Select the highest-scoring candidate, not the first.

**Estimated scope:** ~30-60 LOC. Adds a candidate-scoring loop + optional pricing probe in the selection step. Medium PR.

**Coupled with:** Defect #5 (catalog duplicates) — both share the same code location and must ship together. The combined fix changes "pick `candidates[0]`" into "score-then-select" across the multi-candidate set.

### Defect #2 — `parallelMatches` token-subset over-permissive

**Location:** [cardsight.mapper.ts:67-71](../../backend/src/services/compiq/cardsight.mapper.ts#L67-L71)

**Current behavior:**

```typescript
function parallelMatches(input: string, candidate: string): boolean {
  const inputTokens = tokenizeParallel(input);
  const candidateTokens = tokenizeParallel(candidate);
  return inputTokens.every((t) => candidateTokens.includes(t));
}
```

Input "Blue Refractor" matches both "Blue Refractor" AND "Blue Wave Refractor" because `["blue", "refractor"]` is a subset of `["blue", "wave", "refractor"]`. The `Array.find()` caller returns whichever appears first in `detail.parallels[]` — semantically incorrect.

**Required behavior:** Exact set-equality on tokens (sorted-arrays equal), OR prefer the shortest candidate among multiple subset matches. The former is safer for distinct parallel disambiguation.

**Estimated scope:** ~5-10 LOC. Small PR.

**Coupled with:** None mechanically. Effect-wise, only exercised once defect #3 produces a parsed parallel and defects #1+#5 produce the right parent cardId.

### Defect #3 — `parseCardQuery` SET_PATTERNS ordering + dictionary coverage

**Locations:**
- [cardQueryParser.ts:46-69](../../backend/src/services/compiq/cardQueryParser.ts#L46-L69) — SET_PATTERNS array
- [cardsight.mapper.ts:38-46](../../backend/src/services/compiq/cardsight.mapper.ts#L38-L46) — `COMPIQ_TO_CARDSIGHT_RELEASES` dictionary

**Current behavior (parser side):** SET_PATTERNS is ordered specific-to-general but has a gap: no entry for `bowman draft chrome`. The input `"2024 Bowman Draft Chrome Caleb Bonemer..."` matches `bowman draft` first → set parsed as "Bowman Draft" instead of "Bowman Draft Chrome".

**Current behavior (dictionary side):** `COMPIQ_TO_CARDSIGHT_RELEASES` has 7 entries. Missing entries for `topps update`, `donruss optic`, `topps heritage`, `topps finest`, `topps stadium club`, `panini select`, `panini contenders`, `national treasures`, `flawless`, `upper deck` — all sets that appear in 30 days of production `comp_logs` traffic. Notable existing mis-mapping: `bowman chrome` → "Bowman Draft Chrome" (flagship maps to Draft Chrome, which is a different Cardsight release).

**Required behavior:** Add `bowman draft chrome` ahead of `bowman draft` in SET_PATTERNS. Add the missing entries to `COMPIQ_TO_CARDSIGHT_RELEASES`. Correct the `bowman chrome` mismatch (split into distinct flagship vs draft entries). Validate Cardsight's actual release names via live `searchCatalog` lookups before committing each entry.

**Estimated scope:** ~10-20 dictionary entries + 1-3 SET_PATTERNS entries. Small-to-medium PR depending on how many sets are validated. Implementation effort is bounded by Cardsight's catalog inventory work (look up what release-name strings Cardsight uses for each set, one at a time).

**Coupled with:** None in implementation. Feeds defect #1's catalog query construction — fixes here improve `resolveCardId`'s search input but don't change its selection logic.

### Defect #4 — `isCompVariantMatch` AUTO regex misses "Autographs" / "(AU,"

**Location:** [cardQueryParser.ts:302-306](../../backend/src/services/compiq/cardQueryParser.ts#L302-L306)

**Current behavior:**

```typescript
const AUTO_PREFIX_RE = /\b(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa|bbpa)[- ]/i;
const hasAuto =
  /\bauto(graph(ed)?)?\b/.test(title) ||
  /\brpa\b/.test(title) ||
  AUTO_PREFIX_RE.test(title);
```

`\bauto(graph(ed)?)?\b` matches "auto", "autograph", "autographed" but not "Autographs" (trailing `s` breaks the word boundary). `AUTO_PREFIX_RE` requires `[- ]` after the prefix; the title format `"(AU, RC)"` has `,` after — misses.

**Required behavior:** Extend the regex to match "Autographs" (add `s?` or use `\bauto\w*\b`). Extend AUTO_PREFIX_RE's terminator class to include `[, )]` or use a non-word lookahead. Validate against the sample Cardsight title formats captured during Thread 2 (`"(AU, RC)"`, `"Autographs"` suffix forms).

**Estimated scope:** ~5-10 LOC including a unit-test addition. Small PR.

**Coupled with:** None. Pure filter robustness improvement. Can ship anytime.

### Defect #5 — Cardsight catalog duplicates per logical card

**Location:** Manifests in [cardsight.mapper.ts:89-103](../../backend/src/services/compiq/cardsight.mapper.ts#L89-L103) (catalog search) and [cardsight.mapper.ts:144-156](../../backend/src/services/compiq/cardsight.mapper.ts#L144-L156) (selection).

**Current behavior:** Cardsight's catalog returns 2-11 cardIds per logical player×year×set. Subset carry empty `getPricing` results (catalog entries without pricing data). Subset are namesake players (Geovany Soto matches surname "Soto") or combo/insert cards ("Battery Bath (Walker Buehler / Russell Martin)"). `candidates[0]` can land on any of these. The Path A addendum confirmed: in 10/10 test players across two cohorts, every player has multiple TU Base cardIds with 1-9 empty duplicates each.

**Required behavior:** When multiple candidates remain after `releaseName` + sub-pattern filtering, probe each via `getPricing` (or capture the `meta.total_records` signal cheaply) and prefer the data-bearing cardId with the highest record count. Cache the disambiguation result so subsequent queries for the same player×year×set don't re-probe. Filter out obvious namesake/combo entries by checking that the candidate's player field exactly matches the input playerName when present.

**Estimated scope:** ~40-80 LOC including a small pricing-probe helper and disambiguation cache. Medium PR. Effort dominated by the cache strategy decision (in-process LRU vs Redis vs Cosmos) and by deciding whether the fan-out probe is acceptable on first-call latency budget.

**Coupled with:** Defect #1 — both modify the same selection step. Joint implementation is cleaner than sequenced.

## 3. Dependency graph

```
        ┌──────────────────────────────────────────────┐
        │  Defect #4 — AUTO regex                      │
        │  INDEPENDENT — fixes filter robustness       │
        │  Ship anytime                                 │
        └──────────────────────────────────────────────┘

        ┌──────────────────────────────────────────────┐
        │  Defect #3 — Parser SET_PATTERNS + dict      │
        │  Ship before / alongside #1+#5               │
        │  Improves catalog query input                │
        │  Without #1+#5: no observable effect         │
        └────────┬─────────────────────────────────────┘
                 │ feeds correct product/set
                 ▼
        ┌──────────────────────────────────────────────┐
        │  Defects #1 + #5 — resolveCardId selection   │
        │  MUST SHIP TOGETHER (same code location)     │
        │  Without these: no path to data-bearing      │
        │  cardId → all downstream layers blocked       │
        └────────┬─────────────────────────────────────┘
                 │ produces correct parent cardId
                 ▼
        ┌──────────────────────────────────────────────┐
        │  Defect #2 — parallelMatches set-equality    │
        │  Only meaningful once #1+#5 land             │
        │  AND #3 produces parsed parallel             │
        │  Last-mile parallel disambiguation            │
        └──────────────────────────────────────────────┘
```

| Defect | Files touched | Hard prerequisite | Effect blocker for |
|---|---|---|---|
| #1 | `cardsight.mapper.ts` (selection block) | — | All cardsight-routed queries |
| #2 | `cardsight.mapper.ts` (parallelMatches) | #1+#5, #3 to be observable | Parallel-specific queries (Blue Refractor vs Blue Wave Refractor) |
| #3 | `cardQueryParser.ts`, `cardsight.mapper.ts` (dict) | — | #1's catalog query quality (but #1 fix can ship in parallel) |
| #4 | `cardQueryParser.ts` (AUTO regex) | — | Auto-set comp matches with non-standard title formats |
| #5 | `cardsight.mapper.ts` (selection block) | — | Catalog-duplicate cards (which is most demo cards) |
| #6 | `cardQueryParser.ts` (playerName extraction) | — | Any query that includes a sport-suffix token (e.g. "Baseball", "Football") — parser leaves it attached to playerName |
| #7 | `compiqEstimate.service.ts:1124-1150` (CH-identity guard) | #6 amplifies it but not strictly required | Activation of `/price-by-id` (Step A) — guard's haystack relies on Cardsight populating `card.player`, which Cardsight does NOT do (only `card.name`) |

**Critical observation:** #1 and #5 share a code location. Implementations cannot fully separate. Plan them as a single joint fix.

### Defect #6 — `parseCardQuery` sport-suffix stopword gap

**Location:** [cardQueryParser.ts](../../backend/src/services/compiq/cardQueryParser.ts) — playerName extraction logic (after year/brand/set/parallel stripping).

**Current behavior:** Surfaced during Phase 1 acceptance verification (2026-05-22). Input `"Mike Trout 2011 Topps Update Baseball"` is parsed:
- year=2011 → stripped
- brand="Topps" + set="Topps Update" → stripped
- "Baseball" suffix → NOT stripped (no sport stopword)
- Leftover tokens → playerName="Mike Trout Baseball" (corrupted)

Cardsight's catalog stores set names with sport suffixes (e.g., "2011 Topps Update Baseball"), so iOS-shape queries that copy the catalog's set label include "Baseball" — which the parser then attaches to playerName.

**Required behavior:** Strip sport-suffix tokens (`Baseball`, `Football`, `Basketball`, `Hockey`, `Soccer`) from playerName extraction. Likely a single tokens-to-ignore list addition.

**Estimated scope:** ~5-10 LOC. Small PR.

**Coupled with:** Amplifies defect #7. Without #6's fix, #7 trips for any query with a sport suffix.

### Defect #7 — CH-identity guard's haystack doesn't include Cardsight's actual player field

**Location:** [compiqEstimate.service.ts:1124-1150](../../backend/src/services/compiq/compiqEstimate.service.ts#L1124-L1150)

**Current behavior:** The guard tokenizes `body.playerName` (≥4-char tokens) and checks all tokens appear in `(fetched.card.player ?? "") + " " + (fetched.card.title ?? "")`. Under Card Hedge, `fetched.card.player` was always populated. Under Cardsight, the API response carries `card.name` (the player's name) but NOT a separate `card.player` field — `cardsight.router.ts:findCompsViaCardsight` assigns `baseCard.player = pricing.card?.player ?? undefined`, which is undefined because Cardsight's `card` object has no `player` key. The haystack reduces to just `card.title` (which is also `pricing.card.name`, just under a different field name).

**Required behavior:** Under Cardsight responses, the haystack must include `card.name` (the player's name as Cardsight knows it). The cleanest fix is in the router: when building `baseCard` from a Cardsight `pricing.card`, set `player` from `pricing.card.name` if `pricing.card.player` is absent. Then the existing guard logic works unchanged.

**Estimated scope:** ~5-10 LOC. Small PR. One-line change in `cardsight.router.ts:findCompsViaCardsight` (around the `baseCard` construction) plus a unit test.

**Coupled with:** Blocks Step A (re-ship PR #110 meaningful-query fall-through). Without #7's fix, the guard discards every successful Cardsight resolution from `/price-by-id`, defeating the purpose of re-shipping. Defect #6 amplifies but doesn't gate it — even cleanly-parsed playerNames trip the guard when `card.player` is null AND the haystack's title doesn't happen to contain the surname.

**Verification (during Phase 1 acceptance):** Mike Trout query "Mike Trout 2011 Topps Update Baseball" resolved correctly to cardId `fda530ab` with 133 comps from Cardsight. The guard then trivially discarded all 133 because `parsed.playerName="Mike Trout Baseball"` (defect #6) and `fetched.card.player=null` (defect #7). With "Baseball" removed from the query, defect #6 didn't fire and the guard passed because `card.title="Mike Trout"` matched both `mike` and `trout` tokens — but this is fragile coincidence, not robustness. If `card.title` were null or differently shaped, the guard would still trip even for clean queries.

## 4. Acceptance test queries

Each phase has at least one query whose outcome shifts from broken-to-working when the phase's fixes land. Tests are read-only — hit `/api/compiq/price-by-id` and (where applicable) `/api/compiq/price` with the listed payload; verify the response field set.

### After defect #4 (AUTO regex)

| Test | Payload | Expected after fix |
|---|---|---|
| Variant filter accepts "Autographs" suffix | Unit test: `isCompVariantMatch("2024 Bowman Draft Class of 2024 Autographs Caleb Bonemer #C24-CBO /250 (AU, RC)", { ..., isAuto: true })` | `{ match: true }` (currently returns `{ match: false, reason: "comp_missing_auto" }`) |

### After defects #1 + #5 (resolveCardId selection)

**Endpoint note (correction 2026-05-22, Phase 1 implementation):** acceptance uses `POST /api/compiq/price` (free-text endpoint), NOT `/api/compiq/price-by-id`. The latter is short-circuited under `CARDSIGHT_MODE=exclusive` until PR #110's meaningful-query fall-through is re-shipped (Step A of §6). `/price` exercises the same `fetchComps → findCompsRouted → resolveCardId` code path and is where Phase 1's fix is observable today. `/price-by-id` becomes observable after Step A.

| Test | Payload | Expected after fix |
|---|---|---|
| Mike Trout 2011 TU Base demo | `POST /api/compiq/price { query: "Mike Trout 2011 Topps Update Baseball" }` | `source: "live"` (or "cardsight"), `recentComps.length >= 5`, comps from cardId `fda530ab-...` with title format `"2011 Topps Update Series Mike Trout #US175 ..."` |
| Ohtani 2018 TU Base | `POST /api/compiq/price { query: "Shohei Ohtani 2018 Topps Update Baseball" }` | `source: "live"`, `recentComps.length >= 5`, comps from cardId `23084701-...` (the 1818-record candidate, not the empty duplicate `e5d2c888-...`) |
| Judge 2017 TU Base | `POST /api/compiq/price { query: "Aaron Judge 2017 Topps Update Baseball" }` | `source: "live"`, `recentComps.length >= 5`, comps from cardId `1c810c2c-...` |
| Bobby Witt Jr 2022 Topps Chrome | `POST /api/compiq/price { query: "Bobby Witt Jr 2022 Topps Chrome Baseball" }` | `source: "live"`, `recentComps.length >= 5`, comps from a Topps Chrome (not Topps Update) cardId |
| Niche prospect (DailyIQ-class) | `POST /api/compiq/price { query: "Caleb Bonemer 2024 Bowman Draft Chrome" }` | `source: "live"`, `recentComps.length >= 5`, comps from cardId `626bebd0-...` or sibling |
| Negative — junk player | `POST /api/compiq/price { query: "Fake Player 2099 Topps Update" }` | `source: "no-recent-comps"`, no crash, no `variant-mismatch` |

### After defect #3 (parser + dictionary)

| Test | Payload | Expected after fix |
|---|---|---|
| Bowman Draft Chrome parse | Unit test: `parseCardQuery("2024 Bowman Draft Chrome Caleb Bonemer")` | `{ set: "Bowman Draft Chrome", brand: "Bowman" }` (currently returns `set: "Bowman Draft"`) |
| Topps Update dictionary | Unit test: `lookupReleaseName("topps update")` | Returns `"Topps Update"` (currently `null`) |
| Bonemer Bowman Draft Chrome live | `POST /api/compiq/price-by-id { query: "2024 Bowman Draft Chrome Caleb Bonemer" }` | resolveCardId selects a Bowman Draft Chrome cardId (not Bowman Draft Base), getPricing returns cardsight comps |
| Bowman Chrome flagship vs Draft Chrome | Unit + live: query with `"2024 Bowman Chrome"` should NOT resolve to a Bowman Draft Chrome cardId | resolveCardId picks flagship Bowman Chrome (separate Cardsight release) |

### After defect #2 (parallelMatches set-equality)

| Test | Payload | Expected after fix |
|---|---|---|
| Blue Refractor vs Blue Wave Refractor disambiguation | Unit test on `parallelMatches`: input `"Blue Refractor"` against candidates `["Blue Refractor", "Blue Wave Refractor"]` | Returns true ONLY for "Blue Refractor" exact match. (Currently returns true for both.) |
| Bonemer Blue Refractor /150 live | `POST /api/compiq/price-by-id { query: "2024 Bowman Draft Chrome Caleb Bonemer Blue Refractor Auto" }` | resolveCardId resolves to parent cardId `496a7e19-...` with parallel_id matching Blue Refractor (parallel `0c0d36a1-...`), not Blue Wave Refractor (`cbc2ecd8-...`). Pricing returns Blue Refractor /150 comps (which may be thin per addendum §11 carry-forward). |

## 5. Phased fix sequencing

**Visibility note:** Phase 1's mapper fix is foundational. `/api/compiq/price` exercises it immediately because that endpoint already flows through `findCompsRouted → resolveCardId`. `/api/compiq/price-by-id` activates the same fix only after Step A (PR #110 re-ship), because the route's cardhedge-namespace cardIdSource currently dead-ends under exclusive mode before reaching resolveCardId.

### Phase 0 — Defect #4 (optional, can ship anytime)

**Scope:** Small PR. Extend AUTO regex + AUTO_PREFIX_RE; add unit tests.

**What works after:** Marginal — variant filter no longer falsely rejects "Autographs" / "(AU," titles. Effect invisible until cards reach the filter from a correctly-resolved cardId.

**What still doesn't:** Everything else.

**Recommendation:** Ship Phase 0 standalone before Phase 1 OR roll into Phase 3 — either is fine. Treat as a small cleanup PR.

### Phase 1 — Defects #1 + #5 (resolveCardId selection)

**Scope:** Medium PR. Restructure the selection block in `cardsight.mapper.ts:resolveCardId`. Add candidate-scoring + pricing-probe (or cheap signal-extraction) + disambiguation cache.

**What works after:** Full-text iOS queries against `/price-by-id` start returning cardsight comps for the demo card set (Mike Trout, Ohtani, Judge, Acuna 2011-2018 Topps Update Base, plus a meaningful fraction of the 30-day comp_logs query distribution that currently fails at `candidates[0]`).

**What still doesn't:** Queries that depend on structured set parsing (most "Bowman Draft Chrome Auto" queries). Parallel-specific queries (Blue Refractor vs Blue Wave Refractor). These need Phases 2 and 3.

**Verification:** Run the 5 Phase 1 acceptance test queries against staging or a feature-flagged hobbyiq3 deploy. Watch `comp_logs` `outcome=ok / source=cardsight` rate over 24h; expect a measurable jump.

### Phase 2 — Defect #3 + queryContext plumbing + Step A routing (expanded scope, 2026-05-23)

**Scope reclassified 2026-05-23** after Step A's attempted standalone ship failed acceptance (3/5 iOS-shape, 4/5 simple-shape vs 5/5 required). Step A's routing change (PR #110's meaningful-query fall-through in `/price-by-id`) does not stand alone — it requires queryContext plumbing and dictionary coverage to reach the 5/5 ship gate. Folding Step A into Phase 2 makes the dependency explicit.

**Phase 2 now contains three changes that must ship together:**

1. **Defect #3 — parser SET_PATTERNS + dictionary** (original Phase 2 scope)
   - Add `bowman draft chrome` ahead of `bowman draft` in [cardQueryParser.ts:46-69](../../backend/src/services/compiq/cardQueryParser.ts#L46) SET_PATTERNS
   - Expand [cardsight.mapper.ts:38-46](../../backend/src/services/compiq/cardsight.mapper.ts#L38) `COMPIQ_TO_CARDSIGHT_RELEASES` for `topps update`, `donruss optic`, etc.
   - Validate each new dictionary entry against live Cardsight `searchCatalog` releaseName values

2. **queryContext plumbing** (was implicit in Phase 1's stated future-state, now made explicit)
   - In [compiqEstimate.service.ts](../../backend/src/services/compiq/compiqEstimate.service.ts) `fetchComps` — pass `queryContext: {playerName, cardYear, product, parallel, gradeCompany, gradeValue}` to `findCompsRouted`
   - The structured fields exist in `body` (from parsed-query or direct structured input) but are currently dropped at the `fetchComps → findCompsRouted` boundary
   - Without this, my Phase 1 `resolveCardId` selection logic gets `playerName=cardTitle joined string` instead of structured input, falls through to free-text catalog search

3. **Step A — meaningful-query fall-through in `/price-by-id`** (folded in)
   - Re-apply PR #110's routing change (see preserved branch `feature/step-a-part1-meaningful-query-fallthrough` at commit `f5cd3e7`, kept on origin for Phase 2 to consume)
   - With #1 and #2 above landed, this change activates `/price-by-id` for Cardsight with reliable cardId selection

**Acceptance gate:** 5/5 verified-number demo cards return `source: cardsight` (or `live`) via ALL of `/price`, `/price-by-id`, `/estimate`. No regression on Phase 1's existing /price + /estimate green paths.

**Demo card list locked 2026-05-23** (numbers verified via /search-list against CH catalog):

| Card | CH number | Cardsight number | Status |
|---|---|---|---|
| Mike Trout 2011 Topps Update | US175 | US175 | both agree, canonical demo card |
| Shohei Ohtani 2018 Topps Update | US285 | US153 (top hit; US285 also exists at sibling cardId) | catalog-duplicate; Phase 1 #5 fix handles |
| Aaron Judge 2017 Topps Update | US99 | (variable, depends on catalog hit) | I had US87 wrong; lock US99 |
| Bobby Witt Jr 2022 Topps Chrome Update | USC35 | (variable) | I had USC150 wrong; lock USC35 |
| Caleb Bonemer 2024 Bowman Draft Chrome | CPA-CBO (auto, CH top-ranked) / BD-31 (paper base, CS top-ranked) | both exist as separate cardIds | both valid demo cards for different cases — auto for prospect-auto demos, base for paper RC demos |

**Cross-catalog disagreement finding (2026-05-23):** CH and Cardsight have DIFFERENT card numbers and/or DIFFERENT top-ranked variants for 4 of 5 demo cards. The disagreement is not always wrong — sometimes Cardsight has multiple cardIds (defect #5 catalog duplicates), sometimes CH catalog labels a card with a different number than Cardsight does, sometimes CH ranks the auto variant above the paper base. Any cross-catalog work must handle disagreements explicitly: assume the CH cardId-to-Cardsight cardId mapping is NOT a 1:1 correspondence at the number level. The mapping is via `searchCatalog → resolveCardId` based on player+year+release+parallel, not via card number.

**Scope:** Medium PR. ~80-150 LOC across the three changes plus targeted tests.

**Out of scope (still):** Phase 3 (defect #2 parallelMatches set-equality), defect #4 AUTO regex, defect #6 parser sport-suffix, defect #7 CH-identity guard, MCP rewire (Step B), fn-cardhedge-comps decommission (Step C).

**What works after:** Structured iOS-shape queries route correctly through both `/price` and `/price-by-id`. Demo card set returns Cardsight comps consistently. Harness regression scoreboard becomes meaningful.

**What still doesn't:** Specific-parallel queries (Blue Refractor vs Blue Wave Refractor) — Phase 3 territory. Parser sport-suffix tokens corrupt playerName for /price (defect #6, own PR). CH-identity guard's haystack relies on card.title under Cardsight (defect #7, only manifests on /price with corrupt playerName).

### Phase 3 — Defect #2 (parallelMatches set-equality) and any remaining tightening

**Scope:** Small PR. Change `every-input-token-in-candidate` to sorted-array equality OR add a "prefer-shortest-among-subset-matches" tiebreaker. Add unit tests covering the Blue Refractor / Blue Wave Refractor case.

**What works after:** Parallel-specific queries route to the correct `parallel_id` in `getPricing`. Numbered parallels that *do* have Cardsight sale data return correctly; thin/empty parallels return `no-recent-comps` honestly (vs picking a sibling's data).

**What still doesn't:** Anything not addressed above — vendor-side gaps that remain after consumption fixes (likely small), thin-market parallels with low print runs that genuinely have 0 sales.

## 6. Post-defect CH removal sequencing

Once Phases 1-3 land, the original migration plan applies — but simpler than the 2026-05-22 attempt.

### Step A — Re-ship the `/price-by-id` meaningful-query fall-through (was PR #110)

The reverted PR #110 was correct in concept; it was unblocked at the routing layer but blocked at the selection layer. With Phases 1-3 landed, the same code change can re-ship as a small PR. The change is now low-risk because the underlying `findCompsRouted → resolveCardId → getPricing` path is reliable.

**Sub-prerequisite — defect #7 fix MUST land before or alongside Step A.** Phase 1 acceptance verification surfaced that the CH-identity guard at [compiqEstimate.service.ts:1124-1150](../../backend/src/services/compiq/compiqEstimate.service.ts#L1124-L1150) discards every successful Cardsight resolution because the guard's haystack relies on `fetched.card.player` and Cardsight's response shape leaves that field unset. Without the #7 fix, re-shipping PR #110 would route `/price-by-id` through `resolveCardId` correctly only to have computeEstimate's guard then wipe the comps. Step A is therefore better characterized as a two-part change: (i) re-ship PR #110's meaningful-query fall-through, (ii) fix defect #7's CH-identity guard for Cardsight response shape. Both are small PRs; both must land together to make `/price-by-id` observable.

**Acceptance:** the original PR #110 smoke tests now pass on the iOS-shape query family, not just the WS2-known-good full-text shape.

### Step B — Re-ship the MCP `compsLoader` rewire (was PR #111)

**Architectural mismatch still applies.** MCP `/predict`'s `compsLoader.fetchPlayerComps` makes **player-level** queries; Cardsight is keyed at **card-level**. PR #111 papered over this by calling backend `/api/compiq/price` with just `playerName`, which returns the same `no-recent-comps` for player-only queries that brought down the MCP path yesterday. This mismatch is independent of the five defects characterized in this plan — fixing all five won't make player-level queries return aggregate player pools.

**Three sub-options for MCP rewire (decision deferred to the implementing session):**

1. Per-prediction card-level fetch in `backtest.ts` (refactor scoring loop)
2. New backend `/api/compiq/comps-by-player` aggregation endpoint
3. Decouple `fn-backtest-runner` from MCP entirely

These are documented as carry-forwards in [docs/SESSION_HANDOFF.md](../SESSION_HANDOFF.md) under the 2026-05-22 entry. **The MCP rewire is NOT in scope for v2 Phases 1-3.** It is a fourth phase (or a parallel workstream).

### Step C — `fn-cardhedge-comps` decommission (was WS4)

Can only proceed after both A and B are deployed and demonstrated stable for at least one nightly cycle. Steps from yesterday's plan apply unchanged:
- Set `disabled: true` in `compiq-functions/fn-cardhedge-comps/function.json`
- Comment out the `ch-monitor.yml` cron schedule (the monitor is no longer signal once the function stops writing)
- Optionally set `AzureWebJobs.fn-cardhedge-comps.Disabled=true` on `fn-compiq` app settings for instant production effect

### Step D — Cleanup

- Remove `CARD_HEDGE_API_KEY` from hobbyiq3, compiq-mcp, fn-compiq app settings (only after Steps A-C land and the CH client is provably unused at runtime)
- Delete `cardhedge.client.ts`, `mcp-server/cardhedge.ts` (note: `lookupCardImage` in the latter is still used by `/api/compiq/image` endpoint — needs migration first or that endpoint goes away)
- Remove the `CARD_HEDGE_API_KEY` guard at [compiqEstimate.service.ts:701-704](../../backend/src/services/compiq/compiqEstimate.service.ts#L701-L704)
- Delete blob path entries for `compiq-signals/{player}/cardhedge.json` (after one full retention window post-removal so rollback remains possible)
- Update `copilot-instructions.md` architecture diagram and CH references

## 7. Risks and open questions

1. **2024-2025 Topps Chrome Update Base not yet diagnosed.** The original characterization §11 listed Skenes 2024 Topps Chrome Update USC150 as a coverage-gap candidate. The Path A addendum closed the equivalent question for Topps Update Base sets but did not probe Topps Chrome Update. **Risk:** the catalog-duplicate pattern likely extends to Topps Chrome Update, but unverified. **Mitigation:** include 5 Topps Chrome Update Base cards in the Phase 1 acceptance test set.

2. **MCP `/predict` player-level vs card-level architectural mismatch is unresolved.** Defects 1-5 are in the backend consumption layer; they do nothing for MCP. The Step B decision (sub-options 1-3) is open. **Risk:** the MCP fix scope is unbounded until the sub-option is chosen — could be small (option 3) or large (option 2). **Mitigation:** treat as a separate planning workstream after v2 Phases 1-3 land.

3. **Cardsight first-call latency.** `searchCatalog` has p50 ~9-10s on cache miss per W6.1b. Phase 1's selection logic likely makes additional probe calls (one per candidate when fanning out). Even with the 6h pricing cache, cold paths could push response time past iOS's 60s timeout for queries with many candidates. **Risk:** medium — the Bonemer case had 11 TU candidates for Soto. **Mitigation:** parallelize the probes (Promise.all), short-circuit on first data-bearing hit ordered by Cardsight's relevance ranking, or extend cacheWrap TTL for resolve-results.

4. **A sixth defect could surface during implementation.** Each defect's fix touches a code path that has been broken for the entire production lifetime of `CARDSIGHT_MODE=exclusive`. Adjacent bugs may surface. **Mitigation:** Phase 1's acceptance criteria explicitly include negative tests (junk-player queries must NOT crash). Phase 2's dictionary work surfaces Cardsight release-name discrepancies one at a time.

5. **`parallelMatches` fix (#2) could break the few queries that currently work by accident.** If today some query is succeeding because the subset match catches a related parallel and the data is "close enough," tightening to set-equality may regress those. **Risk:** low (only 6 ok/cardsight rows in 30 days), but worth measuring. **Mitigation:** Phase 3 includes a regression scan against the 6 historical ok/cardsight rows in comp_logs.

6. **The `bowman chrome` → "Bowman Draft Chrome" dictionary mis-mapping** (already pre-existing) needs correction during Phase 2. Cards intended for flagship Bowman Chrome currently mis-route to Draft Chrome. **Risk:** breaking change for any iOS query that currently routes flagship Bowman Chrome and happens to land on a Draft Chrome cardId with data. **Mitigation:** verify against comp_logs whether any of the 4 Bowman Chrome ok/cardsight rows from §3 were flagship or draft chrome cards before changing.

## 8. What this plan does NOT do

- **Does not rebuild any architecture.** `resolveCardId` + `findCompsRouted` + `getPricing` remain the primitives. The defects are bugs inside these, not flaws in the design.
- **Does not expand dictionary as the primary strategy.** Per Thread 1's finding, even when the dictionary maps correctly, Cardsight's catalog text search and `candidates[0]` selection picks the wrong card. Dictionary expansion (defect #3) is necessary but not sufficient. The selection-logic fix (defects #1+#5) is the load-bearing change.
- **Does not introduce a player-aggregation layer in backend.** That was Option B from yesterday's MCP discussion and remains rejected for the same reason: it would treat Cardsight like CH and the data shape doesn't support it. The MCP rewire (Step B) chooses among per-card or decouple-from-MCP, NOT player-aggregation.
- **Does not ship anything in this session.** Planning only. Implementation begins with the Phase 1 PR in a follow-up session.
- **Does not propose calendar timelines.** Phase sizing in PR scope only.
- **Does not restore PR #110 or PR #111 as part of this plan.** Those are Step A and Step B (post-Phase 3) work. Reverts stand until then.

## 9. Recommended next session start point

**First code PR:** Phase 1 — defects #1 + #5 (`resolveCardId` selection).

**Files:** [backend/src/services/compiq/cardsight.mapper.ts](../../backend/src/services/compiq/cardsight.mapper.ts) — the `resolveCardId` function, specifically lines 89-156.

**Scope:** Restructure the selection step from "pick `candidates[0]`" to "score-then-select with data-bearing probe." Estimated 30-80 LOC. Medium PR.

**Acceptance criteria (Phase 1 ship gate):**
- Unit tests for `resolveCardId`: multi-candidate input with mixed data-bearing and empty cardIds → returns the data-bearing one.
- Live smoke against `/api/compiq/price-by-id` with the 5 acceptance test queries from §4 — all return `source: "cardsight"` (or `"live"`), `compsUsed >= 5`.
- Negative smoke: junk player query returns `source: "no-recent-comps"` without crash or variant-mismatch.
- 24h comp_logs observation post-deploy: `outcome=ok / source=cardsight` rate measurably above the pre-fix 1.6% baseline.
- No regression on the 6 historical ok/cardsight rows (re-run those exact queries; outcome should remain `ok`).

**Out of scope for Phase 1:** Dictionary expansion (Phase 2), parallelMatches tightening (Phase 3), AUTO regex (Phase 0 or Phase 3), MCP rewire (post-Phase 3), `fn-cardhedge-comps` decommission (post-Phase 3).

**Decision needed before Phase 1 starts:** the cache strategy for disambiguation results. Two viable options:
- In-process LRU (small, fast, lost on restart)
- Add to existing Redis `cacheWrap` with a key like `cs:resolve:{playerName}:{year}:{product}` and a long TTL (24h)

Recommend Redis — `resolveCardId`'s structured input maps to a stable cache key, and the existing `cacheWrap` infrastructure handles invalidation patterns.

## Anti-drift note

This is a planning document. It does NOT modify `cardsight.mapper.ts`, `cardQueryParser.ts`, or any other source file. It does NOT propose specific fix code beyond function-location and LOC-range characterization. It does NOT decide the cache strategy, the MCP rewire sub-option, or the dictionary expansion list — those decisions belong to the implementing sessions. Phases land sequentially; each Phase's implementation begins with its own focused workstream after the previous Phase ships.
