# Phase 0 / Q3 — Latency Baseline for Prediction Endpoints

**Captured:** 2026-05-21 (PM)
**Source:** Azure App Insights component `hobbyiq-insights` (appId `468bd437-5d16-47b4-90fb-5ee5d41726ae`)
**App Service:** `HobbyIQ3` (rg `rg-hobbyiq-dev`, sub `ce160cf3-ee69-4832-ade2-f0cf57ba2f57`)
**Connection string verified:** `APPLICATIONINSIGHTS_CONNECTION_STRING` on HobbyIQ3 points at `468bd437...` — telemetry component is `hobbyiq-insights`, NOT the misleadingly-named `HobbyIQ3` component (which has zero rows; ditto `HobbyIQ`, `appi-hobbyiq-dev`, `appi-hobbyiq-prod`).

## Queries

### Q3.A — Per-endpoint aggregates (7-day window)

```kusto
requests
| where timestamp > ago(7d)
| where name has "/api/compiq/price" or name has "/api/compiq/search-list" or name has "/api/compiq/search"
| extend endpoint = case(
    name has "/api/compiq/price-by-id", "price-by-id",
    name has "/api/compiq/price",       "price",
    name has "/api/compiq/search-list", "search-list",
    name has "/api/compiq/search",      "search",
    "other")
| where endpoint != "other"
| summarize
    requests_count = count(),
    p50_ms = percentile(duration, 50),
    p95_ms = percentile(duration, 95),
    p99_ms = percentile(duration, 99)
  by endpoint
```

### Q3.B — Daily p95 trend (7-day window)

```kusto
requests
| where timestamp > ago(7d)
| where name has "/api/compiq/price" or name has "/api/compiq/search-list" or name has "/api/compiq/search"
| extend endpoint = case(
    name has "/api/compiq/price-by-id", "price-by-id",
    name has "/api/compiq/price",       "price",
    name has "/api/compiq/search-list", "search-list",
    name has "/api/compiq/search",      "search",
    "other")
| where endpoint != "other"
| summarize p95_ms = percentile(duration, 95), n = count() by bin(timestamp, 1d), endpoint
| order by timestamp asc, endpoint asc
```

## Results

### Per-endpoint aggregates (7d window — see capture-window note below)

| Endpoint        | Requests | p50 (ms) | p95 (ms) | p99 (ms) |
|-----------------|---------:|---------:|---------:|---------:|
| `price-by-id`   |       19 |       15 |      226 |      226 |
| `search`        |       66 |       16 |       96 |      154 |
| `price`         |        1 |     1987 |     1987 |     1987 |
| `search-list`   |        0 |        — |        — |        — |

Raw operation_Name values observed:
- `POST /api/compiq/search` — 66
- `POST /api/compiq/price-by-id` — 19
- `POST /api/compiq/price` — 1
- (no `/api/compiq/search-list` traffic in window)

### Daily p95 trend (14d probed; only 2026-05-21 has data)

| Date         | Endpoint        | p50 (ms) | p95 (ms) | n  |
|--------------|-----------------|---------:|---------:|---:|
| 2026-05-21   | `price-by-id`   |       15 |      226 | 19 |
| 2026-05-21   | `search`        |       16 |       96 | 66 |
| 2026-05-21   | `price`         |     1987 |     1987 |  1 |

## Interpretation

This is the baseline against which Phase 4a cache layer measures success ("p95 reduction >50%" per the roadmap). On today's slice:

- **`price-by-id`** p95 = **226 ms**. Phase 4a target: **≤113 ms**. Sample size (n=19) is small; baseline should be re-measured after a longer soak window before any cache-layer A/B decision.
- **`search`** p95 = **96 ms**. Phase 4a target: **≤48 ms**. Sample size (n=66) is the largest of the three but still <1 hour of capture.
- **`price`** p95 = **1987 ms** from a single sample. Not statistically meaningful. The LLM-mediated full-pricing path is expected to be the slowest; re-measure with n≥30 before treating this as a real baseline.
- **`search-list`** had **zero** production traffic in the 7-day window. Endpoint exists in code but is not being exercised. Phase 4a does not need to cache an unused path.

## Anomalies / Flags

1. **Capture window is effectively ~1 hour, not 7 days.** `requests` telemetry only goes back to 2026-05-21T18:58:11Z (100 total rows in 14-day probe, all from today). Pre-this-window, no `requests` telemetry was captured at all. This is consistent with the broader Phase 0 finding that the production observability layer was largely unwired before PR-A1 / PR-A1.1 today, but raises a contradiction-of-degree with prior characterization: the brief described "warn-line traces at ~9% capture" pre-PR-A1, which implies *some* telemetry was flowing. The reconciliation is likely that the `traces` (custom log) pipeline was partially wired while the `requests` pipeline (auto-instrumented HTTP) was not. Verify in W6.4 / later if needed.

2. **No `search-list` traffic.** Zero hits in 7 days. Either the iOS app no longer calls this endpoint, the caller uses a different name not matching the filter, or it has been dead-code for some time. Cross-check with `compiq.routes.ts` L240 wiring before Phase 1 Track B work.

3. **`price` has n=1.** Not a usable baseline. The single sample's 1987 ms p99 should not be quoted as a Phase 4a target divisor.

4. **No endpoint p99 > 30 s.** No day-over-day swings to compare (only one day with data). No broken-looking values.

5. **App Insights component naming hazard.** Five components exist in `rg-hobbyiq-dev`; four of them are empty / dev-leftover. Future sessions must verify the connection string on the App Service before querying, not assume the obvious-named component (`HobbyIQ3`) is the right one.

## Re-measurement guidance

This baseline should be re-pulled after the 10-day soak window completes (Day-10 review 2026-05-31T17:44:32Z). The numbers above are starter values usable for "is Phase 4a directionally better?" comparison but not for any statistical-significance claim.
