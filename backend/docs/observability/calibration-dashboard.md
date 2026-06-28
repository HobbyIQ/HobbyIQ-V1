# Calibration Validation Dashboard

**Status:** KQL queries authored; App Insights workbook JSON below for import via Azure Portal → Workbooks → Advanced Editor.

CF-CALIBRATION-VALIDATION-DASHBOARD (2026-06-28) — closes step 6 of the ML calibration loop documented in `backend/docs/ml-calibration-architecture.md`.

## Purpose

Track how HobbyIQ's pricing engine's output drifts from CardHedge's authoritative FMV over time. Used to:

1. Validate that calibration refreshes improve accuracy (drift narrows week-over-week)
2. Detect calibration regressions early (auto-multiplier refresh would regress → sanity gate triggers)
3. Surface per-player / per-grade outliers (input for CF-PLAYER-GRADE-OVERRIDES)
4. Audit-trail every calibration deploy + correlate with downstream drift

## Queries

### Q1 — Weekly FMV drift summary
```kql
traces
| where timestamp > ago(60d)
| where message contains "fmv_drift_observed"
| extend p = parse_json(message)
| extend
    ratio = todouble(p.cardFmvRatio),
    engineFmv = todouble(p.engineFmv),
    chFmv = todouble(p.chCardFmv.price)
| where isnotempty(ratio) and ratio > 0
| summarize
    n = count(),
    medianRatio = percentile(ratio, 50),
    p25 = percentile(ratio, 25),
    p75 = percentile(ratio, 75),
    medianEngine = percentile(engineFmv, 50),
    medianCH = percentile(chFmv, 50)
    by week = startofweek(timestamp)
| order by week desc
```

**Read as:** weekly median ratio (engine FMV / CH FMV). 1.0 = perfect parity. Below 1.0 = engine under-prices vs CH. Healthy calibration converges toward 1.0 over time.

### Q2 — Drift by grade tier (where is the engine miscalibrated?)
```kql
traces
| where timestamp > ago(14d)
| where message contains "fmv_drift_observed"
| extend p = parse_json(message)
| extend
    ratio = todouble(p.cardFmvRatio),
    grade = tostring(p.grade)
| where isnotempty(ratio) and ratio > 0 and isnotempty(grade)
| summarize n = count(), medianRatio = percentile(ratio, 50), p25 = percentile(ratio, 25), p75 = percentile(ratio, 75) by grade
| where n >= 5
| order by abs(medianRatio - 1) desc
```

**Read as:** grades whose median drift is furthest from 1.0 are the calibration-debt targets. Filter to `n >= 5` because tiny sample medians are noise.

### Q3 — Drift by player (input for per-player overrides)
```kql
traces
| where timestamp > ago(30d)
| where message contains "fmv_drift_observed"
| extend p = parse_json(message)
| extend
    ratio = todouble(p.cardFmvRatio),
    player = tostring(p.player)
| where isnotempty(ratio) and ratio > 0 and isnotempty(player)
| summarize n = count(), medianRatio = percentile(ratio, 50) by player
| where n >= 5
| order by abs(medianRatio - 1) desc
| take 50
```

**Read as:** the top-50 most-mispriced players relative to CH. These are the natural targets for CF-PLAYER-GRADE-OVERRIDES.

### Q4 — Calibration refresh impact (before/after)
```kql
// Compare drift in the 7d before vs 7d after each auto-multiplier refresh
// commit. A healthy refresh narrows the drift band.
traces
| where timestamp > ago(60d)
| where message contains "fmv_drift_observed"
| extend p = parse_json(message)
| extend ratio = todouble(p.cardFmvRatio)
| where isnotempty(ratio) and ratio > 0
| summarize
    medianRatio = percentile(ratio, 50),
    spread = percentile(ratio, 75) - percentile(ratio, 25),
    n = count()
    by week = startofweek(timestamp)
| order by week desc
| project week, medianRatio, spread, n
```

**Read as:** plot `medianRatio` (should approach 1.0) and `spread` (should shrink) week-over-week. Refresh runs that increase `spread` are calibration regressions.

### Q5 — Sales-momentum signal strength
```kql
traces
| where timestamp > ago(14d)
| where message contains "sales_momentum_observed"
| extend p = parse_json(message)
| extend
    momentumRatio = todouble(p.momentumRatio),
    volumeRatio = todouble(p.volumeRatio),
    player = tostring(p.player)
| where isnotempty(momentumRatio) and momentumRatio > 0
| summarize
    n = count(),
    p25 = percentile(momentumRatio, 25),
    median = percentile(momentumRatio, 50),
    p75 = percentile(momentumRatio, 75),
    surging = countif(momentumRatio > 1.3),
    cooling = countif(momentumRatio < 0.7)
    by week = startofweek(timestamp)
| order by week desc
```

**Read as:** week-over-week, how many priced cards saw their player's sales momentum surge (>30% above mean) vs cool (>30% below). Higher `surging` = cascade pattern firing; downstream predictedPrice should incorporate.

### Q6 — Grade-ladder anchor surface rate
```kql
traces
| where timestamp > ago(14d)
| where message contains "nearest_graded_anchor_surfaced"
| extend p = parse_json(message)
| extend
    anchorGrade = tostring(p.anchorGrade),
    anchorDaysOld = toint(p.anchorDaysOld),
    confidence = todouble(p.confidence)
| summarize
    n = count(),
    medianDaysOld = percentile(anchorDaysOld, 50),
    medianConfidence = percentile(confidence, 50)
    by week = startofweek(timestamp), anchorGrade
| order by week desc, anchorGrade asc
```

**Read as:** which grade anchors are doing the heaviest work in the ladder; whether anchor freshness is improving (median days-old should trend down as CH refreshes).

### Q7 — Player-level data completeness
```kql
traces
| where timestamp > ago(7d)
| where message contains "graded_ratio_observed"
| extend p = parse_json(message)
| extend
    player = tostring(p.player),
    cardId = tostring(p.cardId),
    company = tostring(p.gradingCompany),
    grade = tostring(p.grade)
| where isnotempty(player) and isnotempty(grade)
| summarize observations = count(), uniqueCards = dcount(cardId) by player
| where observations >= 3
| order by observations desc
| take 100
```

**Read as:** how many graded_ratio observations exist per player. Players crossing the `MIN_SAMPLES_FOR_OVERRIDE` threshold (start at 5 unique cards) become eligible for per-player calibration in CF-PLAYER-GRADE-OVERRIDES.

## Acceptance threshold

A healthy state of the calibration loop sustains:

- Q1: weekly `medianRatio` within [0.85, 1.15]
- Q4: `spread` (P75-P25) trending down week-over-week, or stable below 0.5
- Q5: at least 5% of priced cards firing as "surging" or "cooling" (signal is producing meaningful inputs, not flat-line)
- Q6: median anchor `daysOld` trending down (CH freshness improving)
- Q7: number of players crossing 5-observation threshold grows weekly

Falling outside any of these for >2 consecutive weeks is the signal to investigate (next calibration CF or model-level intervention).

## Deployment

Import this into Azure Portal manually:
1. Application Insights → Workbooks → New → Advanced Editor
2. Paste the JSON workbook definition (TODO — generate from the above KQL queries)
3. Save to the `hobbyiq-insights` resource

For now, the queries are paste-ready and can be saved as individual App Insights "Saved Queries" until the consolidated workbook lands.

## Related

- `ml-calibration-architecture.md` — the full loop
- `per-player-grader-calibration.md` — Q3+Q7 feed Steps 2-5
- CF-AUTO-MULTIPLIER-REFRESH-JOB (PR #167) — produces the data Q4 measures
