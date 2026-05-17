# Phase C Pre-Deploy Checklist

Compensating verifications for vitest baseline failures deferred at Phase C ship time.
Each item here was deferred under the condition that the verification below is performed instead.

Source report: [investigations/vitest-baseline-failures.md](./investigations/vitest-baseline-failures.md)

## §1 — Run the tier1 harness against deployed prod

Covers deferrals: **§1, §2, §7** of the baseline report (Mocha-port load failures + supertest timeout against live deps).

- [ ] Run `npm run test:harness:tier1` from `backend/`
  - **Source:** vitest-baseline-failures.md §1, §2, §7
  - **What to verify:** Harness exits 0; no `ECONNREFUSED`, no schema-shape assertion failures, no missing-field errors against prod `HobbyIQ3`.
  - **Pass criteria:** All tier1 harness cases green. (Confirm `HOBBYIQ_API_BASE` is unset or points to prod, per user-memory note about local override 127.0.0.1:8080.)

## §2 — Spot-check Card Hedge fast path + fallback through prod

Covers deferrals: **§5, §6** of the baseline report (CH AI-match wiring tests).

- [ ] Issue 3 prod `/api/compiq/estimate` calls covering both code paths:
  1. **Happy CH AI match** — payload: well-known card, accurate name (e.g., `playerName: "Mike Trout"`, `cardYear: 2011`, `product: "Topps Update"`, `gradeCompany: "PSA"`, `gradeValue: 10`).
  2. **AI miss, search fallback** — same card but with a minor misspelling (e.g., `playerName: "Mike Troutt"`) to force CH `card-match` to return `null` and exercise the `searchCards` fallback.
  3. **Sparse / no parallel** — minimal valid payload (no parallel) for a current-year card.
  - **Source:** vitest-baseline-failures.md §5, §6
  - **What to verify:** Each response has a non-null `fairMarketValue` (numeric) OR a populated `dataSufficiency` block; no 5xx; latency < 8 s on warm Redis.
  - **Pass criteria:** All 3 responses parse, none 5xx, none have *both* null FMV *and* missing `dataSufficiency`.

## §3 — Empty-payload contract check

Covers deferral: **§8** of the baseline report (sparse-payload `dataSufficiency` shape).

- [ ] Issue `POST /api/compiq/estimate` with body `{}` against prod.
  - **Source:** vitest-baseline-failures.md §8
  - **What to verify:** Response is 200 (not 4xx/5xx). If `fairMarketValue === null` then `dataSufficiency.sufficient === false` MUST be present (boolean, not undefined) AND `dataSufficiency.message` MUST be a non-empty string. If `fairMarketValue` is a number, the `dataSufficiency` block is not required (numeric fallback path).
  - **Pass criteria:** One of the two contracts above holds. If neither holds (null FMV + no dataSufficiency block), this deferral promotes to `fix-tonight` — block the Phase C ship and fix the response shape before deploying.

---

## Out of scope for this checklist

- The `defer-with-confidence` deferrals (baseline §3 cache-logger, §4 pricing/compiq-estimate) require no Phase C compensating action — they cover code that no longer exists or has been superseded.
- `fix-tonight` items (none in this baseline) would be handled in their own follow-up PR, not here.
