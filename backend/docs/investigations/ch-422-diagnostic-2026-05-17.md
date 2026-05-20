## CH 422 diagnostic

Date: 2026-05-17T13:31:01.736Z

### Reproduction test (Phase 1)
- Test card query: Aaron Judge 2024 Topps Series 1 base
- Engine-adjacent path used: same CH endpoint and body shape used by `getCardSales()` (`/cards/comps`, POST body `{ card_id, count, grade, include_raw_prices }`)
- HTTP status: 200
- Response: JSON payload with `count_used: 20` and populated `raw_prices`
- Diagnosis: not reproducing as a broad 422 at time of this run

Additional direct re-test using a card_id that returned 422 earlier in the session:
- card_id: 1715551786815x465857243859532540 (Wyatt Langford)
- HTTP status: 200
- Response: populated comps JSON (`count_used: 20`)

Interpretation:
- The earlier 422 wave did not reproduce on this read-only rerun.
- Evidence currently points to intermittent upstream behavior and/or query/card-id specific CH behavior, not a universal always-422 request-path failure.

### Request shape (Phase 2)
- Current request:
  - URL: https://api.cardhedger.com/v1/cards/comps
  - Method: POST
  - Headers: `X-API-Key` (redacted), `Content-Type: application/json`
  - Body:
    - `card_id`: string
    - `count`: number
    - `grade`: string (e.g., Raw)
    - `include_raw_prices`: true
- Last-known-working request (from git baseline `2e2f29d`):
  - URL: https://api.cardhedger.com/v1/cards/comps
  - Method: POST
  - Headers: `X-API-Key` (redacted), `Content-Type: application/json`
  - Body:
    - `card_id`: string
    - `count`: number
    - `grade`: string
    - `include_raw_prices`: true
- Diff: no functional request-shape difference found in local history between baseline and current HEAD for `/cards/comps` calls.

Evidence used:
- Runtime probe output captured status/body for first clean run.
- `git diff 2e2f29d..HEAD -- backend/src/services/compiq/cardhedge.client.ts` showed only comment text changes in the current tree.

### Onset bisect (Phase 3)
Note: phase labels below are evaluated from available local git history + current workspace changes. Not every phase label in the prompt maps to a committed local commit hash.

- Mechanism 1 (most recent): touched CH client path? no request-shape change observed; touched pricing/attribution path (`backend/src/agents/multiplierAnchoredPredictedPrice.ts`, `backend/src/services/compiq/compiqEstimate.service.ts`)
- Cleanup pass: touched CH client path? yes (comments in `backend/src/services/compiq/cardhedge.client.ts`), but no `/cards/comps` request-shape mutation observed
- ADR-0003 Option 3: touched CH client path? touched estimate orchestration path; no evidence of `/cards/comps` payload mutation in current local history
- Multiplier table extension: touched CH client path? no (`backend/src/services/compiq/chromeDraftMultipliers.ts`)
- Phase A.4: touched CH client path? no evidence in local CH client history
- Phase A.3: touched CH client path? no evidence in local CH client history
- Phase A.2: touched CH client path? no evidence in local CH client history
- PR #41 (CH lexical search fix): touched CH client path? yes (query/card-identification/search logic), but no evidence this changed `/cards/comps` request body contract

Best guess at onset point:
- No confirmed code-side onset for a request-shape regression in `/cards/comps` from this diagnostic.

Evidence:
- Reproduction is currently 200 on both a saturated query and one prior-422 card_id.
- Local diff/history does not show a body-schema regression in `_getCardSales()` request construction.

### Scope of impact (Phase 4)
| Card | Status |
|---|---|
| Aaron Judge 2024 Topps Series 1 base | 200 |
| 2023 Topps Chrome refractor Ronald Acuna Jr | 200 |
| 2024 Bowman Chrome prospect autograph Jackson Holliday | 502 |
| 2020 Topps base Mookie Betts | 200 |

Conclusion: not universal 422 in current test window. Failures appear intermittent/endpoint-side and can vary by query/card selection.

### Diagnosis
- Root cause likelihood:
  - request-shape regression: low (no supporting diff evidence)
  - CH upstream instability / endpoint intermittency: medium-high (prior 422 wave plus current mixed-status sample including 502)
  - card/query-specific CH behavior: medium
- Confidence: medium
- Affected scope: non-universal; impacts appear intermittent and potentially subset/query dependent

### Recommendation
- Keep this as an operational risk, not yet a confirmed code regression.
- Capture and persist first-failure artifacts whenever status is non-200 (query, resolved card_id, request body, response body) to isolate whether failures correlate to specific CH card_id families.
- If 422 reappears, run the same bounded 4-card probe immediately and compare with this report before any revert decision.

### Phase C ship implication
- Ship blocker not confirmed as a universal code regression from this diagnostic.
- Reliability risk remains: intermittent non-200 CH responses (including 502 in this run) can still suppress live comp availability and reduce Mechanism 1 live validation quality.

## Re-probe (second sample)

Date: 2026-05-17T13:37:12.097Z
Time since first probe: ~6 minutes

### Test set 1: Alternate validation candidates
| Player | First probe status | Re-probe status | Change |
|---|---|---|---|
| Wyatt Langford | 422 | 200 | transient |
| Druw Jones | 422 | 200 | transient |
| Termarr Johnson | 422 | 200 | transient |
| Elijah Green | 422 | 404 | mixed (improved from 422 but still failing) |
| Jacob Berry | 422 | 200 | transient |
| Cam Collier | 422 | 200 | transient |
| Brooks Lee | 422 | 200 | transient |
| Justin Crawford | 422 | 200 | transient |
| Daniel Susac | 422 | 200 | transient |
| Kumar Rocker | 422 | 200 | transient |
| Owen Murphy | 422 | 200 | transient |
| Andrew Painter | 422 | 200 | transient |

Pattern: most flipped 422->200 (11/12), with one remaining non-200 (404).

### Test set 2: Drake Baldwin
- First probe: not explicitly captured as HTTP status in the earlier Drake live-probe artifact; engine output showed comps available (`compsAvailable: 27`) and populated recent comps, so prior call path was functioning.
- Re-probe: 200
- Comps returned: 22
- Note: query used was `Drake Baldwin 2022 Bowman Chrome auto` and resolved to `card_id=1701218519780x715706808382578600`.

### Test set 3: Fresh saturated controls
| Card | Status | Comps returned |
|---|---|---|
| Aaron Judge 2024 Topps base | 200 | 22 |
| 2023 Topps Chrome refractor Ronald Acuna Jr | 200 | 22 |
| Jordan Lawlar 2022 Bowman Chrome auto | 200 | 4 |

### Conclusion
- CH reliability assessment: intermittent.
- 422 pattern interpretation: mostly transient for the 12-candidate set, with residual non-200 behavior still present (404 on Elijah Green card_id in this sample).
- Drake Baldwin null cause: mixed/inconclusive from this re-probe alone; CH instability likely contributed to earlier 422 wave, but Drake's prior null also involved strict variant mismatch gating on the requested blue refractor auto.

### Phase C ship implication
- Ship with caveat: re-probe supports a transient CH 422 episode rather than persistent universal failure, but CH reliability remains intermittently degraded (non-200 responses still possible). The engine returning null on degraded CH responses remains correct defensive behavior.
