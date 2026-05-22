# Phase 2 design — parser + dictionary + queryContext plumbing + Step A routing

**Date:** 2026-05-23 PM (after Step A rollback)
**Status:** Design only. No code. Implementation follows as a separate workstream.
**Inputs read:**
- `docs/phase0/ch_removal_v2_plan.md` at `02e5ccf` (Step A rollback findings + locked demo card numbers)
- `docs/phase0/cardsight_coverage_characterization.md` at `9af3db2` + addendum `d31b2ff`
- `docs/SESSION_HANDOFF.md` 2026-05-23 AM + PM entries (`a121baf`, `6f25d06`)
- Preserved branch `feature/step-a-part1-meaningful-query-fallthrough` at `f5cd3e7` (Step A routing diff)

## 1. Context and what changed since the v2 plan

**Phase 1 shipped on 2026-05-23 AM** (PR #112, squash-merge `5c9d561`). The `resolveCardId` mapper fix + LRU cache + startup warming are live on hobbyiq3 at `a121baf`. Phase 1 covers `/api/compiq/price` and `/api/compiq/estimate` for the 5/5 demo card set; both ship-gate-passing in production smoke.

**Step A was attempted as a standalone PR on 2026-05-23 PM and rolled back.** The branch `feature/step-a-part1-meaningful-query-fallthrough` (commit `f5cd3e7`) re-applies PR #110's meaningful-query fall-through routing in `/price-by-id`. It was deployed to hobbyiq3 without PR open, smoke gated at **3/5 with verified iOS-shape displayLabel queries** (4/5 with simpler shapes), and rolled back to `a121baf`. The branch is preserved at origin for Phase 2 to consume. Root cause of the smoke failure: routing change works mechanically, but iOS-shape queries (`"2017 Topps Update Baseball Aaron Judge US99 Base"`) contain noise (`"Baseball"`, `"Base"`, card number) that contaminates Cardsight's catalog text-search. `resolveCardId` then receives the joined cardTitle as `playerName` with no structured `cardYear`/`product`/`parallel` — the release filter doesn't fire, the pricing probe lands on insert candidates instead of the actual Topps Update Base RC.

**Two additional findings from today** worth capturing for design:
1. **/estimate is iOS's primary pricing path** and was Phase-1-covered for free (verified via grep + 5/5 smoke).
2. **CH and Cardsight catalog disagree on demo card numbers/variants for 4 of 5 demo cards.** Mike Trout US175 is the only universal agreement. Mapping between catalogs is NOT a number-level 1:1.

**Phase 2 (expanded scope)** addresses defect #3 + queryContext plumbing + Step A's routing change as one coherent PR. Three changes must ship together because the smoke gate can't pass without all three: Step A alone activates a broken text-search path, parser+dictionary alone improve the parse but the structured fields never reach `resolveCardId`, and queryContext plumbing alone has no narrowed `product` to use until the parser+dictionary fix lands.

## 2. Defect characterization (Phase 2 scope)

### Defect #3a — `parseCardQuery` SET_PATTERNS ordering gap

**File:** [backend/src/services/compiq/cardQueryParser.ts:46-69](../../backend/src/services/compiq/cardQueryParser.ts#L46)

**Current behavior:** SET_PATTERNS iterates in declaration order, first match wins. The pattern `[/bowman\s+draft/i, "Bowman", "Bowman Draft"]` (line 49) matches before `[/bowman\s+chrome\s+draft/i, ...]` (line 47, **different word order — "Chrome Draft" not "Draft Chrome"**) for an input like `"2024 Bowman Draft Chrome Caleb Bonemer"`. The "Bowman Draft Chrome" sequence the user typed is not a declared pattern; the parser produces `set: "Bowman Draft"` and `brand: "Bowman"`.

**Required behavior:** Add `[/bowman\s+draft\s+chrome/i, "Bowman", "Bowman Draft Chrome"]` **before** the existing `bowman draft` pattern. The "Bowman Chrome Draft" word-order pattern at line 47 stays for backward compatibility but is rarely the user's input.

**Estimated scope:** 1-2 lines added.

**Tests required:** `parseCardQuery("2024 Bowman Draft Chrome Caleb Bonemer")` returns `{ set: "Bowman Draft Chrome", brand: "Bowman" }`. Confirm Bonemer's iOS displayLabel parses cleanly.

### Defect #3b — `COMPIQ_TO_CARDSIGHT_RELEASES` missing demo-card sets

**File:** [backend/src/services/compiq/cardsight.mapper.ts:38-46](../../backend/src/services/compiq/cardsight.mapper.ts#L38)

**Current state:** 7 entries — `topps chrome`, `topps chrome update`, `bowman chrome` (mismaps to "Bowman Draft Chrome"), `bowman draft`, `bowman draft chrome`, `panini prizm`, `donruss`.

**Required minimum additions for 5/5 demo gate:**
- `"topps update"` → `"Topps Update"` (covers Trout, Ohtani, Judge — three of the five demo cards)
- Correct `"bowman chrome"` → `"Bowman Chrome"` (currently points to Bowman Draft Chrome — wrong release for flagship Bowman Chrome queries; the Step A smoke surfaced Witt 2022 TCU mismapping to wrong catalog)

**Required additions for harness/DailyIQ coverage** (deferrable but small):
- `"donruss optic"` → likely `"Donruss Optic"` — validate via Cardsight `searchCatalog`
- Topps flagship variants if any DailyIQ watchlist player uses them: `topps heritage`, `topps finest`, `topps stadium club`

**Validation method:** For each new entry, one `searchCatalog(<playerName> <releaseName>, year: <year>)` call to confirm Cardsight returns a candidate with that exact `releaseName` field. If Cardsight uses a different string, use Cardsight's actual string as the value. This is one-time setup work, not runtime; the goal is to match what Cardsight's catalog actually returns.

**Estimated scope:** 3-8 dictionary entries, ~10 lines, plus a comment block flagging the `bowman chrome` correction as a potentially-breaking change for any existing query that happened to coincidentally land on a Bowman Draft Chrome cardId with data. Backward-compat audit: comp_logs 30d shows 76 `Bowman Chrome` queries with 4 ok/cardsight rows; need to verify none of those depend on the current mismap.

**Tests required:** `lookupReleaseName("topps update")` returns `"Topps Update"`. Unit test that the `bowman chrome` mapping no longer points to Draft Chrome. Verify the 4 historical Bowman Chrome ok-rows still pass post-change.

### queryContext plumbing — `fetchComps → findCompsRouted` boundary

**Files:**
- [compiqEstimate.service.ts:779](../../backend/src/services/compiq/compiqEstimate.service.ts#L779) — the call site that loses structured fields
- [compiqEstimate.service.ts:1053](../../backend/src/services/compiq/compiqEstimate.service.ts#L1053) — `computeEstimate` calls `fetchComps(cardTitle, grade, cardHedgeCardId)` with no body
- [cardsight.router.ts:94-104](../../backend/src/services/compiq/cardsight.router.ts#L94) — `toCardsightQuery` already accepts `opts.queryContext` and falls back to `query` for playerName

**Current behavior:** `computeEstimate` builds `cardTitle = [playerName, year, product, parallel, ...].filter(Boolean).join(" ")` and passes ONLY that joined string to `fetchComps`. `fetchComps` passes `query` (the cardTitle string) to `findCompsRouted` without any structured context. `toCardsightQuery` then sees `opts.queryContext === undefined` and falls back to `{playerName: query, cardYear: undefined, product: undefined, parallel: undefined}` — handing `resolveCardId` a contaminated free-text playerName.

**Required behavior:** Thread structured body fields from `computeEstimate` → `fetchComps` → `findCompsRouted` as `opts.queryContext`. The router already consumes `queryContext` if present. `resolveCardId` already uses structured fields when provided (Phase 1 verified this). The change is purely the threading.

**Design constraints:**
- Backward-compatible: `queryContext` is optional. Existing callers that don't pass it still work (toCardsightQuery's fallback path).
- Fields to thread: `playerName`, `cardYear`, `product`, `parallel`, `gradeCompany`, `gradeValue`. These map cleanly from `CompIQEstimateRequest` body fields.
- `fetchComps` signature: add 4th optional parameter `queryContext?: FetchCompsQueryContext` (interface declared in service file). Old callers pass undefined; new caller in `computeEstimate` builds and passes the context.

**Difference from yesterday's B1 attempt** (which the user reverted): B1 implemented this same plumbing, but `resolveCardId` was still picking `candidates[0]` blindly. With the same structured input flowing through, `resolveCardId` selected the wrong cardId because the catalog filter narrowed correctly but the selection step was broken. Phase 1 fixed the selection step. Phase 2's queryContext plumbing now feeds a working selection step.

**Estimated scope:** ~15-25 lines in `compiqEstimate.service.ts`. Type definitions, signature extension, threading at the call site.

**Tests required:** Unit test that `computeEstimate` with a structured body passes the structured fields to `findCompsRouted` via `queryContext`. Trace test: mock `findCompsRouted`, assert `opts.queryContext.playerName === body.playerName` and the year/product fields match. Reuse the existing `cardsight.mapper.test.ts` pattern.

### Step A routing change — `/price-by-id` meaningful-query fall-through

**File:** [compiqEstimate.service.ts:706-732](../../backend/src/services/compiq/compiqEstimate.service.ts#L706) (per the f5cd3e7 diff)

**Current behavior:** `fetchComps` with `pinnedCardId` set goes directly to `getCardSalesRouted(pinnedCardId, ...)` which under `CARDSIGHT_MODE=exclusive` returns `[]` (Cardsight router's cardhedge-namespace cardIdSource guard). Result: `/price-by-id` always returns `no-recent-comps` for any pinned-cardId request.

**Required behavior (from f5cd3e7):**

```typescript
const trimmedQuery = (query ?? "").trim();
const hasMeaningfulQuery =
  trimmedQuery.length > 0 &&
  pinnedCardId !== undefined &&
  trimmedQuery !== pinnedCardId.trim();

if (pinnedCardId && !hasMeaningfulQuery) {
  // legacy path — pinnedCardId only, no useful query text
}
// fall through to findCompsRouted(query, opts) which now receives queryContext
```

**Consumption strategy:** Cherry-pick or re-apply the f5cd3e7 diff. The change is small and self-contained; re-applying freshly is cleaner than cherry-picking because (a) the surrounding code may have been touched, (b) the f5cd3e7 commit message implies a revert-the-revert which adds narrative noise. Recommendation: re-apply the routing logic freshly with a comment block referencing the Phase 1 + Phase 2 + Step A history.

**Estimated scope:** ~30 lines re-applied (the diff was +33/-5 in `compiqEstimate.service.ts`).

**Tests required:** Re-apply the test additions from `compiqEstimatePinnedCard.test.ts` (the f5cd3e7 test diff added a "meaningful-query fall-through" case that needs to re-land). With queryContext now plumbed, the `findCompsRouted` mock in that test should also assert `opts.queryContext` is populated when computeEstimate runs with structured body fields.

### Defect #6 — parser sport-suffix stopword (decision: include)

**File:** [backend/src/services/compiq/cardQueryParser.ts:209-216](../../backend/src/services/compiq/cardQueryParser.ts#L209) — the `NOISE` array filtered out of playerName extraction.

**Current behavior:** `NOISE` contains noise tokens to strip during playerName extraction (`"auto", "rookie", "rc", "draft", "bowman", "topps", "panini"`, etc.) but no sport suffixes. Input `"Mike Trout 2011 Topps Update Baseball"` → playerName `"Mike Trout Baseball"` because "Baseball" survives the strip.

**Required behavior:** Add `"baseball", "football", "basketball", "hockey", "soccer"` to NOISE list.

**Estimated scope:** 1 line.

**Tests required:** `parseCardQuery("Mike Trout 2011 Topps Update Baseball")` returns `playerName: "Mike Trout"`. Tests cover all four sports.

**Decision: include in Phase 2.** The fix is 1 line, the test is 5 assertions, total LOC < 10. Defect #6 directly enables 5/5 smoke gate when iOS-shape queries reach `/price` (currently /price would fail on any "Baseball"-suffix query because of the playerName corruption → CH-identity guard cascade). Bundling avoids a follow-up PR for ~1 line.

## 3. Design decisions

### 3a. SET_PATTERNS expansion strategy

**Decision:** **Option (i) — add specific entries for known sets**, ordered most-specific-first.

Alternatives considered: (ii) flexible tokenization would handle unknown sets but introduces new ambiguity (e.g., "Topps Chrome Sapphire" mis-parses to "Topps Chrome"). (iii) hybrid — too much for Phase 2; defer.

Rationale: The current SET_PATTERNS approach works for known sets. Defect #3a's failure is a missing-entry bug, not a strategy bug. Adding entries scales linearly and is auditable. The failure mode for unknown sets — falling through to the brand-only pattern (e.g., `[/bowman/i, "Bowman", "Bowman"]`) — is reasonable; resolveCardId's release filter then falls through to text matching.

**Minimum entries needed for demo gate:**
- `bowman draft chrome` (before `bowman draft`)
- `topps chrome update` already in list ✓

**Optional entries for harness/DailyIQ:** `panini select`, `bowman platinum`, etc. — already present at the brand-only level. No additions strictly required for Phase 2 ship gate.

### 3b. Dictionary expansion strategy

**Decision:** **Per-entry validation against live Cardsight `searchCatalog` before commit.**

The dictionary maps CompIQ-internal product strings → exact Cardsight `releaseName` field values. The relationship is: every SET_PATTERN entry that maps to a Cardsight-known release needs a dictionary entry. SET_PATTERN entries for sets Cardsight doesn't carry (e.g., obscure niche products) don't need dictionary entries — the release filter falls through and Phase 1's pricing-probe-fallback handles them.

**Validation step:** For each new entry, run a `searchCatalog(<sample player name> <release name>, year: <year>)` call. Confirm the returned `releaseName` field is exactly what the dictionary value should be. If Cardsight returns `"Topps Update"` (no sport suffix in the field), the dictionary value is `"Topps Update"`. If Cardsight returns `"Topps Update Baseball"`, the dictionary value is that. Capture the actual Cardsight field value, don't guess.

**Minimum entries needed for demo gate:**
- `"topps update"` → (Cardsight value to be confirmed by live probe; likely `"Topps Update"`)
- Correct `"bowman chrome"` → `"Bowman Chrome"` (currently mismaps to Draft Chrome)

**Open question:** Does Cardsight populate `releaseName` consistently across all 2017-2024 Topps Update cards? The Path A addendum showed Cardsight has multiple cardIds per logical card; the `releaseName` field may vary across duplicates. Validation should sample at least 3 players per release to confirm consistency.

### 3c. queryContext plumbing data flow

**Decision:** **fetchComps signature extension + computeEstimate builds the context.**

Data flow:

```
/price-by-id handler:  body = { cardHedgeCardId, query, gradeCompany, gradeValue }
                       computeEstimate(body)
                              ↓
computeEstimate:       parseCardQuery(body.query) — IF query is meaningful free text
                       OR use body's structured fields directly — IF body has them populated
                       cardTitle = build joined string
                       queryContext = {
                         playerName: body.playerName ?? parsed.playerName,
                         cardYear: body.cardYear ?? parsed.year,
                         product: body.product ?? parsed.set,
                         parallel: body.parallel ?? parsed.parallel,
                         gradeCompany: body.gradeCompany ?? parsed.gradingCompany,
                         gradeValue: body.gradeValue ?? parsed.grade,
                       }
                       fetchComps(cardTitle, grade, cardHedgeCardId, queryContext)
                              ↓
fetchComps:            findCompsRouted(query, { grade, limit, queryContext })
                              ↓
findCompsRouted:       (under CARDSIGHT_MODE=exclusive)
                       findCompsViaCardsight(query, opts)
                              ↓
findCompsViaCardsight: resolveCardId(toCardsightQuery(query, opts))
                              ↓
toCardsightQuery:      returns { playerName, cardYear, product, parallel,
                                 gradeCompany, gradeValue } from opts.queryContext
                              ↓
resolveCardId:         (Phase 1 selection logic) — narrows by releaseName,
                       disambiguates cardNumber, pricing-probes top-3
```

**Where parseCardQuery runs:**
- `/price` route handler — already calls `parseCardQuery` upstream via `requestFromParsed`. Body arrives at `computeEstimate` already structured. queryContext built directly from body.
- `/price-by-id` route handler — does NOT currently call `parseCardQuery`. Body arrives with `playerName: query` (the raw string). `computeEstimate` should call `parseCardQuery(body.query)` defensively, then merge: body's explicit fields (`gradeCompany`, `gradeValue`, `cardHedgeCardId`) take precedence; parsed fields fill gaps.
- `/estimate` route handler — body arrives fully structured (per CompIQEstimateRequest type). queryContext built directly. parseCardQuery not needed.

**Implementation:** Add parsing to `computeEstimate` as a defensive fallback when structured fields are absent:

```typescript
// Inside computeEstimate, before queryContext build
const needsParsing = !body.cardYear && !body.product && body.playerName?.match(/\b(19|20)\d{2}\b/);
const parsed = needsParsing ? parseCardQuery(body.playerName!) : null;
// Then body fields take precedence, parsed fills gaps
```

This handles all three route handlers without forcing each route to call parseCardQuery — keeps the parse cost off /estimate (which doesn't need it) but covers /price-by-id (which does, because iOS sends `query` as a free-text displayLabel).

**Caching note:** Phase 1's LRU cache key is on the structured fields (playerName, cardYear, product, parallel, cardNumber, gradeCompany, gradeValue). With queryContext now populated, the cache key aligns with the warming step's keys. Cache hit rate should activate from 0% (Phase 1 deployed but ineffective on /price's joined-string keys) to non-zero on repeat queries. **Verify in smoke:** log resolveCardId_cache_stats after warming + 5-card cold + 5-card warm. Hit rate >60% on warm calls.

### 3d. Step A routing change consumption

**Decision:** **Re-implement freshly in the Phase 2 PR with a comment block referencing the history.**

Rationale: The f5cd3e7 commit is a revert-the-revert, which carries history noise (`Reapply "feat..." This reverts commit 83ea415...`). Re-applying freshly produces a cleaner commit narrative. The diff is small enough (~30 lines) that re-implementation is trivial.

**Comment block to include in the new code:**

```typescript
// ----- Phase 2 — meaningful-query fall-through ------------------
// Re-applies the routing change from PR #110 (originally shipped
// 2026-05-22 as commit 9124e54, reverted 2026-05-22 PM as commit
// 83ea415, attempted as Step A standalone PR 2026-05-23 PM as
// commit f5cd3e7, rolled back same-day pending Phase 2's
// queryContext plumbing + dictionary expansion).
//
// When the iOS client sends a meaningful `query` text alongside
// cardHedgeCardId, fetchComps falls through to findCompsRouted →
// resolveCardId → Cardsight getPricing under CARDSIGHT_MODE=exclusive.
// The cardHedgeCardId remains the prediction cache key (see
// compiq.routes.ts:786) — only the fetch path changes.
```

**Meaningful-query definition (unchanged from f5cd3e7):**
```typescript
const trimmedQuery = (query ?? "").trim();
const hasMeaningfulQuery =
  trimmedQuery.length > 0 &&
  pinnedCardId !== undefined &&
  trimmedQuery !== pinnedCardId.trim();
```

The `query !== pinnedCardId` check guards against iOS sending the opaque cardId as the query (iOS `resolvedLabel` falls back to cardId when displayLabel/title are both empty — see `HobbyIQ/CompIQSearchModels.swift:27-32`).

### 3e. Defect #6 inclusion

**Decision: include in Phase 2.** Rationale captured in §2 above. 1 line of code, ~5 unit-test assertions. Bundling is cheaper than a follow-up PR.

## 4. Acceptance criteria

### Demo card ship gate (5/5 required across 3 endpoints)

| Card | /price query | /price-by-id query (displayLabel from /search-list) | /estimate body |
|---|---|---|---|
| Mike Trout 2011 TU US175 | `"Mike Trout 2011 Topps Update"` | `"2011 Topps Update Baseball Mike Trout US175 Base"` + `cardHedgeCardId=1586812246197x228...` | `{playerName:"Mike Trout", cardYear:2011, product:"Topps Update"}` |
| Ohtani 2018 TU US285 | `"Shohei Ohtani 2018 Topps Update"` | `"2018 Topps Update Baseball Shohei Ohtani US285 Base"` + cardId from search-list | `{playerName:"Shohei Ohtani", cardYear:2018, product:"Topps Update"}` |
| Judge 2017 TU US99 (locked, not US87) | `"Aaron Judge 2017 Topps Update"` | `"2017 Topps Update Baseball Aaron Judge US99 Base"` + cardId | `{playerName:"Aaron Judge", cardYear:2017, product:"Topps Update"}` |
| Witt Jr 2022 TCU USC35 (locked, not USC150) | `"Bobby Witt Jr 2022 Topps Chrome Update"` | `"2022 Topps Chrome Update Baseball Bobby Witt Jr. USC35 Base"` + cardId | `{playerName:"Bobby Witt Jr", cardYear:2022, product:"Topps Chrome Update"}` |
| Bonemer 2024 BDC CPA-CBO | `"Caleb Bonemer 2024 Bowman Draft Chrome"` | `"2024 Bowman Draft Chrome Baseball Caleb Bonemer CPA-CBO Base Auto"` + cardId | `{playerName:"Caleb Bonemer", cardYear:2024, product:"Bowman Draft Chrome"}` |

**Per-card expected response:** `source: "cardsight"` (or `"live"` in the legacy CH-shape), non-empty `recentComps`, valid `fairMarketValue`. Acceptance: 5/5 on each endpoint.

### Regression gates

- Phase 1's 4 historical ok rows from comp_logs (`"2024 bowman chrome mike trout"`, `"2019 Vladimir Guerrero Jr Topps Chrome RC"`, `"2018 Shohei Ohtani Topps Chrome RC"`, `"2020 Bobby Witt Jr Bowman Chrome Refractor BDC-1"`) still pass on /price.
- Backend test suite stays green (725+ tests; expect ~10+ new tests from Phase 2 additions).
- No new `variant_mismatch` outcomes on previously-working queries.
- No regression on /estimate (Phase 1 acceptance).

### Cache activation check

After deploy + 5-min warmup, capture `resolveCardId_cache_stats` log: hit rate on the 5 warmed demo cards should be **>60% after a second pass** through the 5/5 smoke. (First pass: cold misses + warming-key match → some hits. Second pass: all hits.)

## 5. Implementation sequencing within the PR

Four commits on the feature branch, intended to squash on merge but written separately for review clarity:

### Step 1 — Parser SET_PATTERNS + NOISE list (defects #3a + #6)

Files: `cardQueryParser.ts` only.

- Add `[/bowman\s+draft\s+chrome/i, "Bowman", "Bowman Draft Chrome"]` before line 49.
- Add `"baseball", "football", "basketball", "hockey", "soccer"` to NOISE array at line 209-216.
- Tests: extend existing parser tests with the new assertions.

Verification: `npx vitest run tests/cardQueryParser` (or wherever the parser tests live). All parser tests pass; new assertions pass.

### Step 2 — Dictionary expansion (defect #3b)

Files: `cardsight.mapper.ts` only.

- Live-probe Cardsight for the correct `releaseName` values:
  - `searchCatalog("Mike Trout Topps Update", year: 2011)` → confirm `releaseName` field
  - Same for Bowman Chrome flagship validation
- Add `"topps update"` → confirmed value.
- Correct `"bowman chrome"` mismap to point to the flagship `"Bowman Chrome"` Cardsight release.
- Tests: extend `cardsight.mapper.test.ts` with `lookupReleaseName` assertions for the new entries.

Verification: vitest pass + manual /search-list smoke against the corrected dictionary (a quick read-only probe to confirm the new dictionary values match Cardsight's catalog response).

### Step 3 — queryContext plumbing (the load-bearing change)

Files: `compiqEstimate.service.ts` (signature + threading), `cardsight.mapper.test.ts` (assertion that opts.queryContext is populated).

- Extend `fetchComps` signature with optional `queryContext?: FetchCompsQueryContext`.
- Define `FetchCompsQueryContext` interface in the service file (matches the existing `QueryContext` type from `cardsight.router.ts`).
- In `computeEstimate`, build queryContext from body fields (with parseCardQuery fallback when body lacks year/product but query has them).
- Thread queryContext through to `findCompsRouted(query, { grade, limit: 25, queryContext })`.
- Test that the queryContext reaches `findCompsRouted`'s opts.

Verification: vitest pass; trace test asserts the threaded fields match body.

### Step 4 — Step A routing change folded in

Files: `compiqEstimate.service.ts` (re-apply f5cd3e7's fetchComps changes), `compiqEstimatePinnedCard.test.ts` (re-apply f5cd3e7's test changes).

- Re-apply the meaningful-query fall-through logic from §3d.
- Update test fixture to cover both the legacy cardId-only path and the meaningful-query fall-through path.

Verification: full backend test suite passes. Trace through to confirm `/price-by-id` with a meaningful query now routes through findCompsRouted.

### Step 5 — Integration smoke and PR

- Deploy to a feature-branch staging slot if available, or to hobbyiq3 (with explicit rollback plan).
- Run 5-card smoke against `/price`, `/price-by-id`, `/estimate`.
- Run 4-row regression smoke.
- Capture `resolveCardId_cache_stats` log post-warmup.
- Open PR. Eyeball pass. Merge. Deploy (already done if staging-first; otherwise this is the deploy step).

## 6. Test plan

### Unit tests (added in PR)

| Module | Test | Assertion |
|---|---|---|
| cardQueryParser.ts | New SET_PATTERN entry | `parseCardQuery("2024 Bowman Draft Chrome Caleb Bonemer")` → `set: "Bowman Draft Chrome"` |
| cardQueryParser.ts | Sport-suffix stopword | `parseCardQuery("Mike Trout 2011 Topps Update Baseball")` → `playerName: "Mike Trout"` (not "Mike Trout Baseball") |
| cardQueryParser.ts | Football suffix | `parseCardQuery("Tom Brady 2000 Topps Football")` → `playerName: "Tom Brady"` |
| cardsight.mapper.ts | New dictionary entry | `lookupReleaseName("topps update")` → `"Topps Update"` |
| cardsight.mapper.ts | Corrected bowman chrome | `lookupReleaseName("bowman chrome")` → `"Bowman Chrome"` (not "Bowman Draft Chrome") |
| compiqEstimate.service.ts | queryContext threading | Mock `findCompsRouted`; assert `opts.queryContext.playerName === body.playerName` |
| compiqEstimate.service.ts | parseCardQuery fallback in computeEstimate | When body has only `playerName` containing year+set, queryContext gets populated cardYear/product |
| compiqEstimatePinnedCard.test.ts | Meaningful-query fall-through (re-applied from f5cd3e7) | Test that pinned+meaningful query routes via findCompsRouted, not legacy getCardSalesRouted |
| compiqEstimatePinnedCard.test.ts | Opaque-query legacy path (re-applied) | Test that pinned+`query === cardId` falls back to legacy path |

### Integration test (one end-to-end happy-path)

Mike Trout iOS-shape displayLabel through `/price-by-id`:
- Mock `cardsight.client.searchCatalog`, `getCardDetail`, `getPricing`
- Stub iOS displayLabel: `"2011 Topps Update Baseball Mike Trout US175 Base"` + `cardHedgeCardId=1586812246197x...`
- Expected: queryContext populated, resolveCardId returns Cardsight cardId fda530ab, getPricing returns mocked comps, computeEstimate returns `source: "live"` with non-zero recentComps.

### Production smoke (post-deploy, in smoke script)

5 demo cards × 3 endpoints = 15 calls. Each must return `source: "cardsight"` or `"live"` with non-empty `recentComps`. Captured in a smoke script at `.tmp-phase2-smoke.mjs` (deleted before commit).

## 7. Deploy plan

**Sequence:**

1. Code committed on `feature/phase2-defect3-and-queryContext-and-stepa` branch.
2. PR opened against `main`. Description includes:
   - Reference to this design doc
   - Diff summary across the 4 commits
   - Test plan results
   - Local smoke results
3. **Eyeball pass before merge.** No deploy yet.
4. Merge (squash) to main.
5. Deploy to hobbyiq3 (slim-zip + SCM_DO_BUILD pattern).
6. Verify `/api/health` SHA.
7. Run production smoke. If 5/5: ship complete. If <5/5: rollback (see below).

**Rollback path:** Redeploy hobbyiq3 from Phase 1's SHA. Phase 1's main commit is `5c9d561`; current main HEAD is `02e5ccf` (rollback fold + handoff). Either is a clean rollback target. Branch `feature/phase2-...` stays for diagnostic.

**No deploy before PR.** Process correction from 2026-05-23 PM stands: PR → eyeball → merge → deploy.

## 8. Risks and open questions

### Sixth-defect surfacing risk

History shows every workstream surfaces something. Phase 2's risk surface includes:
- **Cardsight catalog inconsistency on the corrected `bowman chrome` mapping** — verify the 4 historical Bowman Chrome ok-rows still resolve to data-bearing cardIds after the mapping change. Could surface a defect where Cardsight has both "Bowman Chrome" and "Bowman Draft Chrome" releases that need different handling.
- **parseCardQuery fallback in computeEstimate** introducing parse cost on /estimate's hot path. /estimate's body arrives structured; the `needsParsing` guard should keep parse cost off the hot path, but verify in smoke that /estimate's latency doesn't regress.
- **queryContext key alignment with LRU cache** — if computeEstimate's parseCardQuery fallback produces slightly different normalized values than the warming step's structured input (capitalization, whitespace), cache hit rate stays at 0%. Need to confirm key normalization is consistent.

### Cardsight catalog disagreements beyond demo cards

The Step A re-smoke confirmed CH and Cardsight catalog disagree on 4 of 5 demo cards. Phase 2's dictionary expansion is the right fix for the demo cards, but other harness/DailyIQ players may have additional disagreements not yet characterized. **Open question:** how do we validate the dictionary across the full DailyIQ watchlist before shipping? Recommendation: defer to a focused validation pass after Phase 2 lands; Phase 2 ships if the 5/5 demo gate + 4/4 regression gate pass, and additional players are characterized in a later session.

### Performance — parseCardQuery on every /price-by-id call

`computeEstimate` would call `parseCardQuery` defensively when body lacks structured fields. /price-by-id sends a free-text `query` that needs parsing. parseCardQuery is synchronous and bounded (<1ms per call typically) but worth confirming in production smoke that p50 latency on /price-by-id doesn't regress noticeably (current p50 is ~50-300ms cold).

### LRU cache hit rate post-Phase-2

Phase 1's smoke showed 0% hit rate because warming used structured keys and /price queries arrived with joined-string keys. Phase 2 fixes the alignment. Expected hit rate: >60% on the 5 warmed cards' repeat queries. **Verify in smoke; if hit rate doesn't activate, the key normalization is wrong.**

### Defect #7 unaddressed

CH-identity guard's Cardsight-blindness (defect #7) remains. The guard skips when `cardHedgeCardId` is set, so /price-by-id is unaffected. /price could still trip the guard if parseCardQuery produces a corrupted playerName. Defect #6's stopword fix removes the most common corruption case. The guard should be robust enough post-#6, but a query that produces a playerName Cardsight doesn't recognize (e.g., misspelling) would still trip. **Open question:** under Cardsight mode, should the guard be relaxed or skipped entirely? Defer this to its own decision session; Phase 2 ships without touching the guard.

### MCP /predict architectural mismatch

Unchanged from prior sessions. Phase 2 doesn't touch MCP. The three sub-options for MCP rewire (per-card refactor, new aggregation endpoint, decouple from MCP) remain queued post-Phase-2.

### 2024-2025 Topps Chrome Update Base coverage

The Path A addendum noted Topps Chrome Update Base wasn't probed for catalog-duplicate patterns. Witt Jr's locked card is 2022 TCU USC35; Phase 2's smoke will exercise this case. If the dictionary's `topps chrome update` mapping + Phase 1's pricing probe resolve correctly, the carry-forward is closed. If not, it's a defect.

## 9. What this PR does NOT do

- Doesn't decommission `fn-cardhedge-comps`
- Doesn't touch MCP-side `compsLoader`
- Doesn't fix defect #7 (CH-identity guard) — orthogonal under cardHedgeCardId-set paths; only affects /price with corrupt playerName, which defect #6 mostly resolves
- Doesn't fix defect #4 (AUTO regex) — already deferred per v2 plan
- Doesn't fix defect #2 (parallelMatches set-equality) — Phase 3 scope
- Doesn't migrate LRU cache to Redis
- Doesn't add a CompIQ corpus structured-input row type (was an aside in `compiqEstimate.ts:2032-2040`; not Phase 2 scope)

## 10. Recommended next session start

After this design doc commits:

1. Open Phase 2 implementation session.
2. Create branch: `git checkout main && git pull && git checkout -b feature/phase2-parser-dict-querycontext-stepa`
3. Implement Step 1 (parser SET_PATTERNS + NOISE). Commit. Verify tests pass.
4. Implement Step 2 (dictionary expansion with live-probe validation). Commit. Verify tests + dictionary probe.
5. Implement Step 3 (queryContext plumbing). Commit. Verify tests + trace.
6. Implement Step 4 (Step A routing re-apply). Commit. Verify tests + integration.
7. Full backend test suite green.
8. Local smoke if practical, otherwise straight to staging or hobbyiq3 with explicit rollback plan.
9. PR open. Eyeball pass.
10. Merge. Deploy. Smoke. If 5/5: ship complete and update SESSION_HANDOFF. If <5/5: rollback and characterize the failure.

**Ship gate is 5/5 demo cards via /price + /price-by-id + /estimate.** Below that, HALT and surface.

## Anti-drift note

This document is design-only. It does NOT modify `cardQueryParser.ts`, `cardsight.mapper.ts`, `compiqEstimate.service.ts`, or any other source file. Each defect's fix is *characterized* with file:line references and LOC estimates; the implementation belongs to the next session.

Open design questions (called out in §3 and §8) that the implementing session should resolve before writing code:

1. Cardsight's actual `releaseName` field values for `topps update` and `bowman chrome` — confirm via live probe before committing dictionary entries.
2. Bowman Chrome dictionary correction — verify against the 4 historical ok-rows in comp_logs that current behavior they depend on doesn't break.
3. Cache key normalization between warming (structured input) and /price computeEstimate's parseCardQuery fallback — ensure both produce identical normalized keys.

---

## Pre-implementation diagnostic findings (2026-05-23 PM, read-only)

Resolves the three open design questions from §10. One new defect surfaced during Q3 (cardNumber regex gap) — captured below as **defect #8** and folded into the Phase 2 scope as a small addition to defect #6's existing PR.

### Q1 resolved — Cardsight releaseName values verified

**Method:** For each demo card, probed `searchCatalog(<player> <releaseStr>, year)` (the exact query shape `resolveCardId` constructs when the dictionary has a mapping) and captured the `releaseName` field values from the response.

| Card | searchCatalog query | Cardsight `releaseName` | candidates with that releaseName |
|---|---|---|---|
| Mike Trout 2011 TU | `"Mike Trout"` year=2011 | **`"Topps Update"`** | 1 (cardId fda530ab Base Set) |
| Shohei Ohtani 2018 TU | `"Shohei Ohtani"` year=2018 | **`"Topps Update"`** | 2 (catalog-duplicate per defect #5) |
| Aaron Judge 2017 TU | `"Aaron Judge Topps Update"` year=2017 | **`"Topps Update"`** | 14 (catalog has 14 Judge cards under this release; 411dbd50 is the Base Set) |
| Bobby Witt Jr 2022 TCU | `"Bobby Witt Jr Topps Chrome Update"` year=2022 | **`"Topps Chrome Update"`** | 5 (8722ee0e + 6134bc63 are Base Set) |
| Caleb Bonemer 2024 BDC | `"Caleb Bonemer"` year=2024 | **`"Bowman Draft"`** | 3 (BD-31 Base + CPA-CBO Auto + Class of 2024 Auto) |

**Important nuance:** Searching with just `<player>` + year filter doesn't always surface Topps Update / Topps Chrome Update cards (Judge with bare-player query returned only Bowman/Donruss releases; Witt similarly). The catalog text-search benefits from the release name being IN the query string. This is exactly what `resolveCardId` does when the dictionary has a mapping — `queryParts.push(releaseName)`. So adding `"topps update"` → `"Topps Update"` to the dictionary makes the catalog query effective, NOT just the post-fetch filter.

**Locked dictionary additions for Phase 2:**

```typescript
// Add to COMPIQ_TO_CARDSIGHT_RELEASES:
"topps update": "Topps Update",          // covers Trout 2011, Ohtani 2018, Judge 2017, Acuna 2018
```

**Bowman Chrome correction** (catalog probe `"Mike Trout Bowman Chrome"` year=2011 returns `["Bowman Draft Picks & Prospects", "Bowman Chrome"]` distinct releaseNames — confirms Cardsight has a flagship `"Bowman Chrome"` release distinct from `"Bowman Draft Chrome"`):

```typescript
// Change:
"bowman chrome": "Bowman Draft Chrome",  // current — INCORRECT (flagship maps to draft)
// To:
"bowman chrome": "Bowman Chrome",        // corrected — flagship maps to flagship
```

**No other dictionary changes required for the 5/5 demo gate.** `"topps chrome update"` → `"Topps Chrome Update"` is already in the dictionary (covers Witt). `"bowman draft chrome"` → `"Bowman Draft Chrome"` is already in the dictionary (covers Bonemer's Chrome Prospect Auto subset).

**Open question for Phase 2's smoke verification:** Cardsight has TWO Topps Update Base Set candidates for Ohtani 2018 (defect #5 catalog-duplicate); Phase 1's pricing-probe top-3 should pick the data-bearing one. Witt has FIVE Topps Chrome Update candidates; same coverage. Verify in smoke that the pricing probe picks correctly.

### Q2 resolved — Bowman Chrome regression risk: LOW

**Historical ok/cardsight rows containing "Bowman Chrome" (30d):** 8 rows, 2 distinct queries:

| Distinct query | Count | Parser output (current code) | Live /price result (Phase 1 deployed) |
|---|---:|---|---|
| `"2020 Bobby Witt Jr Bowman Chrome Refractor BDC-1"` | 5 | set=`"Bowman Chrome"`, brand=`"Bowman"`, parallel=`"Refractor"` | `source=live, 3 comps, cardId 98a86c16-8650-41` |
| `"2024 bowman chrome mike trout"` | 3 | set=`"Bowman Chrome"`, brand=`"Bowman"`, parallel=null | `source=live, 5 comps, cardId de9211f2-2316-4e` |

**Risk analysis under the corrected `"bowman chrome" → "Bowman Chrome"` mapping:**

Both queries currently succeed because the current (incorrect) `"Bowman Draft Chrome"` mapping accidentally finds data-bearing candidates via Phase 1's pricing-probe (when releaseName filter narrows to Bowman Draft Chrome candidates, the probe picks one with data — possibly the wrong card semantically, but the response shape has non-zero comps).

After the correction:
- `resolveCardId` searches Cardsight for `"<player> Bowman Chrome"` with year filter
- Cardsight catalog HAS a `"Bowman Chrome"` release (confirmed via probe — distinct from `"Bowman Draft Chrome"`)
- Filter narrows to the correct release; pricing probe picks the data-bearing flagship Bowman Chrome cardId
- Result: same `source=live` outcome OR cleaner (right card semantically); regression unlikely

**Both queries should still pass post-correction.** Risk is low. **Mitigation:** Phase 2's smoke includes both historical queries as regression checks; if either regresses, the correction can be staged behind a temporary fallback (dictionary lookup falls back to "Bowman Draft Chrome" if the corrected "Bowman Chrome" finds zero candidates).

### Q3 resolved — Cache key alignment FAILS without a parser fix; new defect #8 surfaced

**Warming-side key for Mike Trout 2011 Topps Update:**
```
"mike trout|2011|topps update|||||"
```

**Request-side key computed from parseCardQuery on iOS displayLabel** `"2011 Topps Update Baseball Mike Trout US175 Base"`:
```
"baseball mike trout us|2011|topps update|||||"
```

**Mismatch.** `playerName` differs because parseCardQuery's playerName extraction doesn't strip:

1. **`"Baseball"`** — defect #6 (already characterized). Sport-suffix not in NOISE list.
2. **`"US175"` → `"US"` → `"Us"` residue** — **NEW DEFECT #8.** The cardNumber regex at [cardQueryParser.ts:152-153](../../backend/src/services/compiq/cardQueryParser.ts#L152-L153) is:
   ```typescript
   text.match(/#([A-Z]{1,3}-?\d+)\b/i) ||   // requires # prefix OR optional hyphen
   text.match(/\b([A-Z]{1,3}-\d+)\b/);      // requires explicit hyphen
   ```
   Neither matches `"US175"` (no `#` prefix, no hyphen). cardNumber stays null. Then the digit-strip at [line 222](../../backend/src/services/compiq/cardQueryParser.ts#L222) `.replace(/[^a-zA-Z\s'-]/g, " ")` removes the digits, leaving `"US"` to survive into playerName.

**Verified across all 5 demo cards** — none of their iOS displayLabel formats produce a clean cache key match against warming:

| Card | Warming key | Request key (parseCardQuery on displayLabel) | Match |
|---|---|---|---|
| Mike Trout | `mike trout\|2011\|topps update\|...` | `baseball mike trout us\|2011\|topps update\|...` | ✗ |
| Shohei Ohtani | `shohei ohtani\|2018\|topps update\|...` | `baseball shohei ohtani us\|2018\|topps update\|...` | ✗ |
| Aaron Judge | `aaron judge\|2017\|topps update\|...` | `baseball aaron judge us\|2017\|topps update\|...` | ✗ |
| Bobby Witt Jr | `bobby witt jr\|2022\|topps chrome update\|...` | `baseball bobby witt jr usc\|2022\|topps chrome update\|...` | ✗ |
| Caleb Bonemer | `caleb bonemer\|2024\|bowman draft chrome\|...` | `baseball caleb bonemer cpa-cbo\|2024\|bowman draft\|...` | ✗ |

Bonemer has a third contamination pattern (`"CPA-CBO"` — letter-only hyphenated card number). The cardNumber regex's `\d+` requirement means letter-only second part doesn't match either.

### Defect #8 — `parseCardQuery` cardNumber regex misses unhyphenated and letter-only patterns

**Location:** [backend/src/services/compiq/cardQueryParser.ts:152-153](../../backend/src/services/compiq/cardQueryParser.ts#L152-L153)

**Current behavior:**
```typescript
const cardNumMatch = text.match(/#([A-Z]{1,3}-?\d+)\b/i) ||
                     text.match(/\b([A-Z]{1,3}-\d+)\b/);
```

Misses:
- `"US175"` (no `#` prefix, no hyphen) — Topps Update / Topps Chrome Update common format
- `"USC150"`, `"USC35"` (same pattern) — Topps Chrome Update common
- `"CPA-CBO"`, `"C24-CBO"` (letter-letter, no digits in second part) — Bowman Draft autograph subset format

**Required behavior:** Expand regex to capture all three patterns:
```typescript
const cardNumMatch =
  text.match(/#([A-Z0-9]{1,5}-?[A-Z0-9]+)\b/i) ||    // hashed
  text.match(/\b([A-Z]{1,4}-[A-Z0-9]+)\b/) ||         // hyphenated (letter or letter-mixed)
  text.match(/\b([A-Z]{1,4}\d+)\b/);                  // NEW: unhyphenated US175/USC35
```

**Estimated scope:** 3-5 lines (regex expansion + careful ordering to avoid mis-matching grade tokens like `"PSA 10"`). Plus 4-6 unit-test assertions covering the new patterns.

**Coupled with:** Defect #6 (sport-suffix stopword). Both contribute to playerName contamination on iOS displayLabel queries. Bundle in the same parser PR. Together they take playerName from `"Baseball Mike Trout Us"` to `"Mike Trout"`.

**Test cases required:**
```typescript
parseCardQuery("2011 Topps Update Mike Trout US175 Base") → cardNumber: "US175", playerName: "Mike Trout"
parseCardQuery("2022 Topps Chrome Update Bobby Witt Jr. USC35 Base") → cardNumber: "USC35", playerName: "Bobby Witt Jr"
parseCardQuery("2024 Bowman Draft Caleb Bonemer #CPA-CBO Auto") → cardNumber: "CPA-CBO", playerName: "Caleb Bonemer"
parseCardQuery("Bowman Draft Caleb Bonemer C24-CBO /250") → cardNumber: "C24-CBO", playerName: "Caleb Bonemer"
```

### Q3 corrected outcome — cache key alignment AFTER defects #6 + #8 are fixed

With both fixes applied, parseCardQuery on `"2011 Topps Update Baseball Mike Trout US175 Base"` should produce:
- year: 2011
- set: "Topps Update", brand: "Topps"
- cardNumber: "US175" (captured)
- parallel: null
- playerName: "Mike Trout" (no Baseball, no US residue)

Resulting cache key: `"mike trout|2011|topps update|||us175||"` — STILL doesn't match warming's `"mike trout|2011|topps update|||||"` because warming has `cardNumber=undefined` while parsed has `cardNumber="US175"`.

**Two options for cache-key alignment:**

**Option A — exclude cardNumber from cache key.** Modify `buildCacheKey` to drop the cardNumber field. Cache key becomes player+year+product+parallel+gradeCompany+gradeValue. Warming targets are player-level so they'd match request-side queries regardless of card number. Cost: cache becomes per-player-per-year-per-product, which is correct for the catalog resolution. Cards differing only by number share a cache entry, which is wrong only if they resolve to different cardIds — but `resolveCardId` uses cardNumber for detail-probe disambiguation, not catalog narrowing, so the resolved cardId might differ. **Cache could return wrong cardId for queries with different card numbers.** Not safe.

**Option B — include cardNumber in warming targets.** Warming inputs gain a cardNumber field for each target. Keys match. Warming covers cardNumber-specific entries. New maintenance burden: warming list expands; verified card numbers from Q1 (US175, US285, US99, USC35, CPA-CBO) need adding. ~10 LOC change to CACHE_WARM_TARGETS.

**Recommendation: Option B.** Cache stays correct; warming inputs expand to include known card numbers. The 10 warming targets get cardNumber fields populated with verified values from Q1's diagnostic.

**Estimated scope for Option B:** ~10 LOC in `cardsight.mapper.ts` CACHE_WARM_TARGETS constant. No logic change — just data.

### Phase 2 scope adjustment

Original Phase 2: parser SET_PATTERNS (#3a) + dictionary (#3b) + queryContext plumbing + Step A routing + defect #6 stopword.

**Updated Phase 2 scope adds:**
- Defect #8 — parseCardQuery cardNumber regex expansion (3-5 LOC + tests)
- CACHE_WARM_TARGETS expansion — add `cardNumber` field to each of the 10 warming targets (~10 LOC, data only)

Total LOC range updates: was ~100-150 LOC, now **~115-170 LOC**. Still small-to-medium PR. No structural change to the design; the new defect #8 is a refinement of the parser layer.

### Updated ship gate verification step

Post-deploy smoke now also captures cache hit rate as an explicit check:

1. Run 5/5 cold smoke against /price + /price-by-id + /estimate
2. Run 5/5 warm smoke (immediately repeated)
3. Capture `resolveCardId_cache_stats` log from docker stream
4. **Expected: hit rate ≥ 60% on the warm pass** (warming primed + cold pass populated + warm pass hits)

If hit rate stays at 0% on the warm pass, key normalization needs a second look before declaring Phase 2 shipped.

### Updated open questions for implementing session

1. ~~Cardsight's actual `releaseName` field values~~ — RESOLVED. Dictionary additions locked: `"topps update"` → `"Topps Update"` (the only required addition); `"bowman chrome"` correction to `"Bowman Chrome"`.
2. ~~Bowman Chrome dictionary correction regression risk~~ — RESOLVED. LOW risk. Both historical queries should still pass; smoke includes them as regression checks.
3. ~~Cache key normalization~~ — RESOLVED via expanded scope: defect #8 cardNumber regex + Option B warming-target cardNumber fields.

**New open question** for the implementing session:
- The Phase 1 commit (`5c9d561`) is currently on `main` and deployed. After Phase 2 ships, an LRU cache *invalidation* may be needed if any of the warming target card numbers turn out to be wrong (per Q1, Witt Jr's number from CH was USC35 but Cardsight's Witt 2022 TCU Base candidates are 8722ee0e and 6134bc63 — Cardsight may have its own catalog numbering different from CH's USC35). Verify each warming target's cardNumber against Cardsight's `getCardDetail` `.number` field before locking in CACHE_WARM_TARGETS.
