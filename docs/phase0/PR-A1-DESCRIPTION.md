# PR-A1: Restore observability — comp_logs writer + cardsight structured logs

## Summary

Restores end-to-end observability for the CompIQ pricing pipeline by:

1. Adding a Cosmos `comp_logs` writer that runs alongside the existing
   `compiq_corpus` writer, capturing per-prediction telemetry needed for
   the soak / regression analytics that PR #102 (cardsight exclusive cutover)
   left without an after-state signal.
2. Adding paired `cardsight.findComps.start` / `.end` structured logs in
   `cardsight.router.ts` so we can measure cardsight catalog-match rate and
   per-leg outcome distribution against `compiq_corpus` + `comp_logs`.
3. Wiring both writers behind a shared `writeTelemetryEntries(...)` helper
   so the 5 prediction sites in `compiq.routes.ts` stay drop-in identical
   to the previous corpus-only call shape.

This is **observability-only**. No prediction-logic changes. No schema
migrations on the engine. Both writers self-gate on independent env-var
sample rates and fail-open / fire-and-forget so a Cosmos outage cannot
block a prediction.

References: PR #102 (cardsight exclusive cutover, `1dec669`), the W3
work plan, and the locked design decisions D1–D5 below.

---

## Locked Design Decisions

| ID | Decision |
|----|----------|
| D1(a) | Wire 5 sites that mirror corpus capture today (`/search`, `/price`, `/price-by-id`, `/bulk` ok, `/bulk` unsupported_sport). `/estimate` excluded — see Follow-up Q below. |
| D2(b) | Schema = W3 minimum + cohort fields: `parallel`, `grade`, `isAuto`, `w7Count/14Count/30Count`, `w7Avg/14Avg/30Avg`. Computed inline by the mapping adapter from `result.recentComps[].soldDate` (engine partitions are 14 / 15–45, not 7/14/30). |
| D3(b) | New independent env var `COMPIQ_COMP_LOGS_SAMPLE_RATE`. NOT reusing `COMPIQ_CORPUS_SAMPLE_RATE` — the two writers must be ramped / paused independently for the soak. |
| D4(c) | `source` is 2-valued (`"cardsight"` \| `"fallback"`); raw provenance preserved in `sourceDetail`. `cardIdSource` is a separate field (`"cardsight"` \| `"cardhedge"` \| `null`). |
| D5 | Shared `writeTelemetryEntries(args)` helper. Each writer self-gates — the helper always invokes both. Verified by the cross-product test in commit 5. |

---

## Commits

| SHA | Title |
|-----|-------|
| `f8fdd72` | feat(observability): add comp_logs writer + config + tests |
| `c7268b7` | feat(observability): add shared writeTelemetryEntries helper + comp_log mapping |
| `a1d96b7` | feat(observability): wire writeTelemetryEntries at all 5 prediction sites |
| `2a0d968` | feat(observability): add cardsight.findComps.start/.end structured logs |
| `ad9c231` | test(observability): cross-product sample-rate gating e2e test |

---

## What's in this PR

### New files

- `backend/src/models/compLogEntry.ts` — `CompLogEntry` interface, `compLogSchemaVersion: 1`. Partition key `/player`. Lower-cased; `"unknown"` fallback.
- `backend/src/services/compLogs/compLogsConfig.ts` — `isCompLogsDisabled()`, `getCompLogsSampleRate()`, one-shot warn flag, `__compLogsConfigInternals.resetWarningFlag()`.
- `backend/src/services/compLogs/writeCompLog.ts` — fire-and-forget Cosmos writer. Lazy `getContainer()` singleton. Gate order: `disabled → rate=0 → Math.random() ≥ rate`. 60s error-log throttle. `__writeCompLogInternals.reset()` for tests.
- `backend/src/services/compLogs/compLogMapping.ts` — `compLogEntryFromPricingResult(args, now)` adapter with tolerant comp coercion (`price|salePrice|amount`, `soldDate|saleDate|date`). Caps comps at 20. `mapSource` / `mapOutcome` / `statsForWindow`.
- `backend/src/services/corpus/writeTelemetryEntries.ts` — D5 shared helper + `extractTelemetryCohortFromResult(result, fallbackQuery, cardIdSourceHint?)`.

### Modified files

- `backend/src/routes/compiq.routes.ts` — 5 sites switched from `writeCorpusEntry(...)` to `writeTelemetryEntries({...})`. `/price-by-id` passes `"cardhedge"` hint and explicit `cardId: cardHedgeCardId`.
- `backend/src/services/compiq/cardsight.router.ts` — wraps `findCompsViaCardsight` with `cardsight.findComps.start` / `.end` logs. Outcomes: `ok | empty | no_match | no_pricing | error | timeout`. `CardsightTimeoutError` is split out so timeout SLOs are independent of generic errors.

### Tests added

- `backend/tests/compLogsConfig.test.ts` — 26 tests
- `backend/tests/writeCompLog.test.ts` — 10 tests
- `backend/tests/compLogMapping.test.ts` — 21 tests
- `backend/tests/writeTelemetryEntries.test.ts` — 3 tests
- `backend/tests/writeTelemetryEntries.crossProduct.test.ts` — 6 tests (matrix 00 / 01 / 10 / 11 + 2 disabled-flag overrides)
- All 29 existing `cardsight.router.test.ts` tests still pass.

**Telemetry suite total: 95/95 passing. `tsc --noEmit` clean.**

---

## Schema deviation note (D2)

The W3 minimum schema covers: `compLogSchemaVersion, player, timestamp, latency_ms, endpoint, cardId, query, cardIdSource, predictedPrice, comps[], confidence, source, sourceDetail, outcome, engineVersion`.

This PR also writes the cohort fields agreed in D2(b): `parallel, grade, isAuto, w7Count, w14Count, w30Count, w7Avg, w14Avg, w30Avg`. These are computed by the mapping adapter; they are not produced by the engine directly.

Rationale: the engine's existing comp partitions are 14 / 15–45; we need 7/14/30 to compare against the public Cardsight benchmarks the soak is targeting. Computing inline avoids an engine change.

---

## Env var deviation note (D3)

Adds `COMPIQ_COMP_LOGS_SAMPLE_RATE` rather than reusing `COMPIQ_CORPUS_SAMPLE_RATE`. The two writers need independent ramps so we can pause one without losing the other if a soak detects an issue. Both env vars are honored by their own writer only; the cross-product test in commit 5 verifies the matrix.

---

## App Insights adaptive sampling caveat (cardsight logs)

The `cardsight.findComps.start`/`.end` lines flow through `console.log` and into App Insights, which is currently configured with adaptive sampling at roughly 9% capture in production. This is acceptable for outcome-distribution analytics (the law of large numbers carries us at the soak volume) but means we should NOT use these logs for absolute counts — that's what `comp_logs` is for. Documented here so reviewers don't conclude the logs are dropping events.

If we need raw cardsight counts during the soak, the appropriate fix is to bump App Insights sampling on a targeted query, not to add another writer.

---

## Pre-existing test failures (unrelated)

The full suite has 7 pre-existing failures in 4 files (`markHoldingSoldFromEbay.test.ts` × 5, `portfolio.routes.test.ts` × 1+) that reproduce on `git stash` of this branch. They are **not** caused by PR-A1 and are out of scope here.

---

## W4 deploy plan (post-merge)

After merge, deploy with our hardened script (Kudu+restart race fix per memory note):

```powershell
# Ramp comp_logs to full sampling for the soak.
az webapp config appsettings set `
  --name hobbyiq3 `
  --resource-group rg-hobbyiq-dev `
  --settings COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0

# Deploy with build info and explicit Kudu polling
.\scripts\deploy-with-build-info.ps1
```

Engine prod is already running `CARDSIGHT_MODE=exclusive` and `COMPIQ_CORPUS_SAMPLE_RATE=0` — neither changes here. PR-A1 only enables `COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0` post-merge.

Verify via `/api/health` that the new SHA is live, then confirm in Application Insights / Cosmos `comp_logs` that entries are arriving for `/api/compiq/search`, `/price`, `/price-by-id`, `/bulk` calls within 10 minutes.

---

## Soak plan

- **B1**: 24h soak — confirm `comp_logs` write rate matches request rate at sample=1.0; confirm zero unhandled rejections in App Insights traces; confirm `cardsight.findComps.end` outcome histogram.
- **B2**: 72h soak — review outcome distribution against PR #102 baseline; identify any `error` / `timeout` cardsight cells exceeding 1% of traffic.
- **B3**: 10-day soak — minimum window before any further pricing-logic decision (e.g. variant-mismatch tuning). Review `comp_logs.confidence` and `predictedPrice` distributions stratified by `parallel` / `grade` / `isAuto`.

**Minimum 10-day soak** before any prediction-logic PR builds on this data.

---

## Known follow-ups

See issue #103 for `/estimate` telemetry follow-up.

---

## What this PR does NOT do

- Does **not** change any pricing math.
- Does **not** modify `compiqEstimate.service.ts` or any engine partition.
- Does **not** turn on `COMPIQ_COMP_LOGS_SAMPLE_RATE` in production — that's a deploy-time setting in W4.
- Does **not** add `/estimate` capture (see Follow-up Q).
- Does **not** change `CARDSIGHT_MODE` or the cardsight router's mode-routing logic.

---

## Reviewer checklist

- [ ] Schema in `compLogEntry.ts` matches the cross-product test assertions
- [ ] `writeTelemetryEntries` self-gating contract verified by cross-product matrix
- [ ] D4 source/sourceDetail/cardIdSource separation reads correctly at all 5 sites
- [ ] Cardsight log shape acceptable given AI adaptive sampling caveat
- [ ] `/estimate` follow-up — tracked in #103
- [ ] W4 deploy plan acceptable
