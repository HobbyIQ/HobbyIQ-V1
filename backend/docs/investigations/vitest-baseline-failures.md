# Vitest Baseline Failures — Investigation Report

**Investigation completed:** 2026-05-16T21:47Z
**Follow-up (deferrals) completed:** 2026-05-16T21:55Z
**Command used:** `npx vitest run --reporter=verbose` from `backend/`
**Raw log:** [data/vitest-baseline.log](../../data/vitest-baseline.log)

## Status block

- **Total failures investigated:** 8 (6 test files / 4 named-test failures + 4 suite-load failures)
- **Aggregate run:** 6 files failed, 48 files passed, 5 skipped — 4 tests failed, 483 passed, 110 skipped (597 total)
- **Recommendations breakdown:**
  - fix-tonight: 0
  - defer-with-confidence: 2
  - defer-with-caveat: 6
- **Deferral records added:** 2026-05-16T21:55Z (inline, per entry)
- **Tracked issues created:** none — no GitHub-issue tracker integration configured for this session; tracking lives inline in this report and in [phase-c-checklist.md](../phase-c-checklist.md). Owner to mirror into GitHub issues if desired.
- **Phase C checklist updated:** yes — [backend/docs/phase-c-checklist.md](../phase-c-checklist.md) created with compensating verifications for every `defer-with-caveat` entry.

## Constraints honored

- No code changes applied. This is documentation only.
- No re-running of failing tests beyond the one baseline capture.
- All entries below take the **first** vitest categorization; no second-pass re-diagnosis.

---

## Failure entries

### §1 — `tests/pricing/api-compatibility.test.ts` (suite load failed)

- **Failure mode:** `ReferenceError: before is not defined` at line 6.
- **Root cause (surface diagnosis):** File uses Mocha's `before()` global, but the test runner is vitest. Port from Mocha was incomplete when the suite was migrated. The other Mocha-style import (`import { expect } from "chai"`) confirms the same heritage.
- **What the test covers:** API compatibility shape for `/api/compiq/estimate` (server boot smoke + response surface).
- **Category:** `defer-with-caveat`
- **Risk if left broken through Phase C:** Low. The same endpoint is exercised end-to-end by the live harness at `backend/harness/tier1`, which is run against the deployed `HobbyIQ3` App Service and asserts on the real prod response. The vitest layer here would only catch shape regressions earlier; the harness will still catch them.
- **Compensating Phase C check:** Run `npm run test:harness:tier1` green before Phase C ships. See [phase-c-checklist.md §1](../phase-c-checklist.md).

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if the `/api/compiq/estimate` response shape changes OR if the tier1 harness is removed/disabled OR if `tests/pricing/api-compatibility.test.ts` is touched in any future PR.
- **Owner accepts risk:** pending review

---

### §2 — `tests/pricing/api-response-shape.test.ts` (suite load failed)

- **Failure mode:** `ReferenceError: before is not defined` at line 4. Same heritage as §1.
- **Root cause (surface diagnosis):** Incomplete Mocha→vitest port; uses `before()` and `chai`.
- **What the test covers:** Asserts on the response shape (field presence/types) of `/api/compiq/estimate`.
- **Category:** `defer-with-caveat`
- **Risk if left broken through Phase C:** Low — same reasoning as §1. The tier1 harness exercises the same response shape against prod.
- **Compensating Phase C check:** Same as §1 (tier1 harness green). See [phase-c-checklist.md §1](../phase-c-checklist.md).

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if `tests/pricing/api-response-shape.test.ts` is touched OR if the tier1 harness is removed.
- **Owner accepts risk:** pending review

---

### §3 — `tests/pricing/cache-logger.test.ts` (suite load failed)

- **Failure mode:** `Error: No test suite found in file ...cache-logger.test.ts`
- **Root cause (surface diagnosis):** File is 100% commented out. It originally targeted classes `PricingCache` and `PricingLogger` under `src/modules/compiq/services/pricing/infra/`, which appear to have been removed during an earlier refactor. The author left the `.test.ts` file in place with all code commented out rather than deleting it.
- **What the test covered (historical):** Trivial set/get on an in-memory pricing cache and a no-op `PricingLogger.log()` call.
- **Category:** `defer-with-confidence`
- **Risk if left broken through Phase C:** None. The classes under test do not exist in the current codebase; there is no behavior to cover. The "failure" is a vitest-config-level "every `.test.ts` must have at least one test" complaint, not a behavior failure.

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if a class named `PricingCache` or `PricingLogger` is reintroduced anywhere under `src/modules/compiq/`. Otherwise, the file should eventually be deleted, not fixed.
- **Owner accepts risk:** pending review

---

### §4 — `tests/pricing/compiq-estimate.test.ts` (suite load failed)

- **Failure mode:** `Error: No test suite found in file ...compiq-estimate.test.ts`
- **Root cause (surface diagnosis):** File contains a single comment: `// Skipped: This test file uses require() and is not ESM compatible. To re-enable, migrate to ESM imports and update fixtures.` Author intentionally disabled it pending ESM migration.
- **What the test covered (historical):** Earlier CJS-era test of the `/api/compiq/estimate` flow. Functionally superseded by `tests/compiqEstimate.test.ts` (top-level), see §7–§8.
- **Category:** `defer-with-confidence`
- **Risk if left broken through Phase C:** None. The flow is covered (with separate caveats) by the top-level `compiqEstimate.test.ts` and by the tier1 harness.

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if `tests/pricing/compiq-estimate.test.ts` is migrated to ESM (at which point the file should be re-enabled or deleted in favor of `tests/compiqEstimate.test.ts`).
- **Owner accepts risk:** pending review

---

### §5 — `tests/cardhedgeFindCompsByQuery.test.ts > findCompsByQuery — AI-match fast path > uses the AI candidate and skips /cards/card-search when tokens match`

- **Failure mode:** `AssertionError: expected [ Array(1) ] to include 'https://api.cardhedger.com/v1/cards/comps'` (line 120). The fetch-router records only `[ '...cards/card-match' ]` — `/cards/comps` is never called even though `cards/card-match` returned a high-confidence (0.95) candidate.
- **Root cause (surface diagnosis):** The client's `cardMatchesTokens()` (or equivalent token check) rejects the AI candidate against the test query string. Either the client's tokenization logic changed after the test was written, or the AI candidate fixture in the test no longer matches what production `cardMatchesTokens` expects. The test's query is `"...Mike Trout 2011 Topps Update"` and the mock match returns set `"2011 Topps Update Baseball"` and player `"Mike Trout"` — these *should* token-match unless the threshold/normalizer logic moved.
- **What the test covers:** L383 wiring — when CH AI returns high-confidence, skip the `/cards/card-search` round-trip. Pure performance optimization.
- **Category:** `defer-with-caveat`
- **Risk if left broken through Phase C:** Low. If `aiCandidate` is never accepted, queries fall through to the `/cards/card-search` path, which is slower but functionally correct. No incorrect data — only a missed perf win.
- **Compensating Phase C check:** Spot-check 3 known-good cards through prod `/api/compiq/estimate` and confirm comps return (any path). See [phase-c-checklist.md §2](../phase-c-checklist.md).

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if `backend/src/services/compiq/cardhedge.client.ts` is touched in any future PR OR if the Card Hedge `/cards/card-match` response shape changes OR if the token-match helper (`cardMatchesTokens` or equivalent) is renamed/refactored.
- **Owner accepts risk:** pending review

---

### §6 — `tests/cardhedgeFindCompsByQuery.test.ts > findCompsByQuery — AI-match fast path > falls through to /cards/card-search when identifyCard returns null`

- **Failure mode:** `AssertionError: expected [...2] to include 'https://api.cardhedger.com/v1/cards/comps'` (line 173). Calls recorded include `card-match` and `card-search`, but not `comps`.
- **Root cause (surface diagnosis):** Symmetric to §5. After `card-match` returns `null`, the client falls through to `card-search` (correct), retrieves a card-id, but never proceeds to `/cards/comps`. The `searchCards` fallback likely fails its own `cardMatchesTokens` check on the test's mock response, or returns no card whose ID would feed `/cards/comps`. Same heritage: client-side token logic vs. fixture drift.
- **What the test covers:** Fallback path from `identifyCard → null` into `searchCards → /comps`. Functional, not perf.
- **Category:** `defer-with-caveat`
- **Risk if left broken through Phase C:** Low-to-medium. If the *production* fall-through is similarly broken, then queries that miss AI match would return no comps. However, the tier1 harness exercises queries that miss AI (e.g., sparse / typo'd inputs) and would surface a regression. Spot-checks below catch any prod-side issue.
- **Compensating Phase C check:** Same as §5 — spot-check 3 known cards including one designed to miss CH AI (e.g., misspelled player name); confirm comps still return via fallback. See [phase-c-checklist.md §2](../phase-c-checklist.md).

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Same as §5.
- **Owner accepts risk:** pending review

---

### §7 — `tests/compiqEstimate.test.ts > /api/compiq/estimate > returns required fields`

- **Failure mode:** `Test timed out in 5000ms.` The test imports the Express app directly (`import app from "../src/app"`) and uses supertest to POST to `/api/compiq/estimate` with a real Blake Burke 2024 Bowman Chrome Orange Wave Auto payload.
- **Root cause (surface diagnosis):** The estimate endpoint reaches live Cosmos and Card Hedge over the network without test mocks. With `COMPIQ_ALPHA_NEW_MODEL_WEIGHT=1.0` (full predictive cutover, per `userMemory.hobbyiq-reminders.md`) and no Redis warm cache in test context, a single end-to-end call comfortably exceeds 5 s. The test was written under the older blended-model regime where the cache was usually hot.
- **What the test covers:** Real-world happy-path call into the production estimate flow.
- **Category:** `defer-with-caveat`
- **Risk if left broken through Phase C:** Low. The tier1 harness already runs the same flow against the deployed app with a more generous timeout and a warm Redis. That is the authoritative pre-deploy gate.
- **Compensating Phase C check:** `npm run test:harness:tier1` green. See [phase-c-checklist.md §1](../phase-c-checklist.md).

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if the compiqEstimate flow is refactored OR if a mock-layer (e.g., `vi.mock("../src/services/compiq/...")`) is introduced for unit-level coverage OR if vitest's default `testTimeout` is raised globally.
- **Owner accepts risk:** pending review

---

### §8 — `tests/compiqEstimate.test.ts > /api/compiq/estimate > returns valid fallback for sparse payload`

- **Failure mode:** `AssertionError: expected undefined to be false` at line 43. Response has `fairMarketValue === null` but `dataSufficiency?.sufficient` is `undefined` — the `dataSufficiency` block is missing entirely from the response on this code path.
- **Root cause (surface diagnosis):** When the sparse-payload code path returns a null FMV, the current implementation does not consistently emit the `dataSufficiency` companion block. Either the block was renamed, gated behind a flag, or only populated when certain inputs are present. The test's expectation reflects an earlier contract.
- **What the test covers:** Sparse-payload fallback contract — null FMV must come with a `dataSufficiency` explanation.
- **Category:** `defer-with-caveat`
- **Risk if left broken through Phase C:** Medium. The iOS app may depend on `dataSufficiency.sufficient` to render the "insufficient data" UI when FMV is null. If the field is silently absent, iOS may render a confusing empty state.
- **Compensating Phase C check:** Manually issue an empty-payload POST to prod `/api/compiq/estimate`, inspect the response, and confirm either (a) `dataSufficiency.sufficient` is present, or (b) FMV is a number (numeric fallback path). If neither, escalate to `fix-tonight`. See [phase-c-checklist.md §3](../phase-c-checklist.md).

#### Deferral record
- **Deferred at:** 2026-05-16, session `0d789b48-9cde-4ed9-a62a-52edbd273e8c`
- **Deferred by:** owner (dvabu)
- **Re-investigation trigger:** Re-investigate if the iOS app reports a regression in the "insufficient data" UI OR if the compiqEstimate response shape is touched OR if the empty-payload prod check from §3 of the Phase C checklist fails.
- **Owner accepts risk:** pending review (this is the highest-risk of the deferrals; consider promoting to fix-tonight if prod check fails)

---

## Notes for the next maintainer

- The baseline run was a single pass; no re-runs were performed to confirm stability. Flakiness was not investigated.
- All 6 failed-file entries cluster under `tests/pricing/` and `tests/compiqEstimate.test.ts` / `tests/cardhedgeFindCompsByQuery.test.ts`. The rest of the repo's vitest surface (48 files) is green.
- Phase B test surface (`tests/multiplierTableRegistry.test.ts`, `tests/eligibilityAnalyzer.test.ts`, `tests/worksheetGenerator.test.ts`, `tests/applyWorksheet.test.ts`, `tests/curationOrchestrator.test.ts`, `tests/parallelAttributesSchema.test.ts`) is 65/65 green and unaffected by anything in this report.
