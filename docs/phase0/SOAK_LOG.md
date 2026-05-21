# PR-A1 Comp_Logs Writer — 10-Day Soak Log

Soak start record for WORKSTREAM 4 (PR-A1 observability + writer rollout).

## Deploy + flip metadata

| Field | Value |
|---|---|
| Deployed SHA | `ea0a7243c3f743985bb9b8246ee454747fe19d6c` (`ea0a724`) |
| Deploy timestamp (App Service `deployedAt`) | `2026-05-21T15:22:23Z` |
| Deploy completion timestamp (verified `/api/health`) | `2026-05-21T15:24:14.05Z` |
| Writer flip (`COMPIQ_COMP_LOGS_SAMPLE_RATE=1.0`) | **`2026-05-21T17:44:32.06Z`** |
| Post-flip `/api/health` first green | `2026-05-21T17:44:48.963Z` (5 s after flip) |
| Post-flip SHA verification | `ea0a724` confirmed unchanged |
| Soak clock start | `2026-05-21T17:44:32Z` (writer flip timestamp) |
| **Expected day-10 review date** | **`2026-05-31T17:44:32Z`** |

App Service: `HobbyIQ3` (rg `rg-hobbyiq-dev`, sub `ce160cf3-ee69-4832-ade2-f0cf57ba2f57`).
Production base: `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net`.
CARDSIGHT_MODE: `exclusive` at flip time.

## Pre-flip Cosmos baseline (2026-05-21T17:42Z)

| Container | Count |
|---|---|
| `comp_logs` | 5 (legacy rows from 2026-05-03; pre-writer-rollout schema) |
| `compiq_corpus` | 12 |

## Post-flip verification (2026-05-21T17:47Z)

Driven by 5 sequential `POST /api/compiq/price` calls (free-text queries):
Witt 2020 BC Refractor, Trout 2011 TU US175, Ohtani 2018 TC RC, Skenes 2024 BC Auto, Vlad Jr 2019 TC RC.
All 5 responses HTTP 200.

| Container | Pre | Post | Δ | Notes |
|---|---:|---:|---:|---|
| `comp_logs` | 5 | **15** | **+10** | Writer firing. See "2× write fan-out" below. |
| `compiq_corpus` | 12 | **12** | 0 | D3 independent control validated. |

### Schema field population (from 10 new rows)

| Field | Status | Notes |
|---|---|---|
| `player` | ✅ 10/10 | Slug form (e.g. `"bobby witt jr"`). Note: `"mike trout us"` for Trout TU US175 — player-slug extraction over-consumed `US175`. Soak-data quality finding, not blocker. |
| `query` | ✅ 10/10 | Verbatim user query. |
| `outcome` | ✅ 10/10 | Mix of `ok` and `no_recent_comps`. |
| `endpoint` | ✅ 10/10 | `/api/compiq/price`. |
| `latency_ms` | ✅ 10/10 | Bimodal — see "2× write fan-out". |
| `isAuto` | ✅ 10/10 | Correctly tags Skenes auto query. |
| `parallel` | ⚠️ 2/10 | Populated only when literal token present (Witt Refractor). Other Chrome/Refractor queries returned `null`. |
| `compLogSchemaVersion` | ✅ present | Versioned. Good. |
| `w7Count` / `w14Count` / `w30Count` / `w7Avg` / `w14Avg` / `w30Avg` | ✅ present in schema | Assumed populated for `outcome=ok`. |
| `cardIdSource` | ❌ **0/10 null** | **Affects B2 baseline.** See known schema gap below. |
| `cardId` | ❌ 0/10 null | Same root cause as `cardIdSource`. |
| `playerName` | ❌ absent from row | Properly-cased player name not plumbed through. Only `player` slug present. |
| `cardYear` | ❌ absent from row | Not plumbed through from query parse. |
| `grade` | ❌ 0/10 null | Test queries had no grade; status indeterminate. |

### 2× write fan-out finding (NEW — not previously known)

Each of the 5 calls wrote **two** rows to `comp_logs`:
- One row with real latency (~2.2 – 3.7 s) at ts =  `17:47:05` – `17:47:13`
- One row with anomalously low latency (`2 – 3 ms`) at ts = `17:47:17` (all 5 in same second)

Rows are identical on `query`, `player`, `outcome`, `parallel`, `isAuto`, `endpoint`. Different `id`s.
Hypothesis: writer fan-out from two code paths in the same request (likely `compiqEstimate.service.ts` early-return path + `writeTelemetryEntries` finalization), OR shadow-pair writer not gated by `CARDSIGHT_MODE=exclusive`.

**Impact on soak metrics**:
- B1 (latency distribution): bimodal, must filter out `latency_ms < 50` to get real distribution.
- B2 (Site B short-circuit rate per cardIdSource): unaffected — gap is `cardIdSource null`, not the duplicates.
- Row counts: double-counted; cohort sizes need de-dup by `(query, _ts_window)` or row-id grouping.

Action: not blocking soak start, but **must be diagnosed before PR-A2 ships** — captured as Phase 1.5 micro-task in followups.

## Baselines (snapshot at flip)

| Baseline | Derivation source | Confirmed viable? |
|---|---|---|
| **B1** latency distribution | `comp_logs.latency_ms` filtered to `>= 50ms` (real-path rows only) | ✅ |
| **B2** Site B short-circuit rate per cardIdSource | `comp_logs.cardIdSource` + `comp_logs.outcome` | ⚠️ **BLOCKED until cardIdSource is plumbed through writeTelemetryEntries.** Phase 1.5 micro-task. |
| **B3** synthetic vs real-user traffic mix | App Insights `requests` table joined on IP/UA | ✅ |

## Known production-only instrumentation gap (carry-over)

`cardsight.findComps.start` / `.end` `log.info` events emit cleanly to local stdout (Run A exclusive + Run B shadow both confirmed pre-flip) but do NOT reach App Service Linux container stdout or App Insights `traces`. Hypothesis B (call-site code defect / JSON.stringify throwing) ruled out. Root cause environmental (stdout pipe state, `setAutoCollectConsole(true,true)` patching behavior, container log buffering). No PR-A1.1 patch shipped — would not fix the environmental issue. Soak proceeds using Cosmos `comp_logs` row count + row contents as primary signal. App Insights findComps traces will be absent in production for the duration of this soak; this is a known production-only emission gap to investigate separately, **not a soak regression**.

## Soak schema gaps (NEW — from step-7 verification)

These are real production-data limitations discovered at flip-time, captured as data-quality constraints for cohort slicing during the soak window:

1. **`cardIdSource` is `null` across all sampled rows.** The writer entrypoint isn't receiving `cardIdSource` from the router/translator. **Blocks B2 cohort slicing.** Must be diagnosed; either fix during soak (small patch) or accept B2 as deferred to PR-A2.
2. **`cardId` is `null` across all sampled rows.** Same root cause as #1.
3. **`playerName` / `cardYear` absent from row schema.** `compLogEntryFromPricingResult` isn't writing these fields. Cohort slicing on player-name (capitalized) and year not possible during soak — only the `player` slug field is available.
4. **`parallel` only populates when literal token in query string** (e.g. "Refractor"). Cross-parallel cohort slicing weakened.
5. **2× row fan-out per request** — must de-duplicate before computing cohort-level aggregates.

## Decision gates

- **C2 (route-level passthrough for queryContext / cardIdSource / playerName / cardYear)**: review at day 10. Likely fold in to PR-A2 since gaps 1–4 above all stem from incomplete passthrough.
- **C3 (corpus → comp_logs migration)**: precommitted to Phase 4a. No change.

## Mid-soak contingency

Extend, do not restart, if traffic shape changes meaningfully (e.g. CARDSIGHT_MODE flips, synthetic monitor configuration changes, or unexpected production restart wipes the soak window).
