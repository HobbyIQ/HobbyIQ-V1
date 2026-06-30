# Cross-Observed Inversion Telemetry Queries

**Status:** Queries authored for the `cross_observed_inversion_fired` event shipped in PR #201.

CF-CROSS-OBSERVED-INVERSION-GUARD (2026-06-29) — the engine reconstructs higher-grade observed medians when they invert with a more-trusted lower grade. Every firing emits a structured event for KQL analysis. These queries surface the patterns that justify follow-up engine tuning, calibration adjustments, or CH escalation.

## Event shape

```json
{
  "event": "cross_observed_inversion_fired",
  "source": "buildGradeBreakdown",
  "player": "Mickey Mantle",
  "cardId": "...",
  "grader": "PSA",
  "higherGrade": "10",
  "lowerGrade": "9",
  "originalHigherMedian": 2639,
  "originalHigherCount": 3,
  "lowerMedian": 3249,
  "lowerCount": 8,
  "reconstructedMedian": 6498,
  "ratio": 2.0,
  "inversionPctOriginal": 18.8,
  "passNumber": 1,
  "timestamp": "2026-06-30T01:00:00Z"
}
```

Emitted from [marketRead.service.ts:logCrossObservedInversionFired](../../src/services/compiq/marketRead.service.ts) via `buildGradeBreakdown`.

## Queries

### Q1 — Firing rate over time (is the guard active?)

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_observed_inversion_fired"
| extend p = parse_json(message)
| summarize
    firings = count(),
    distinctCards = dcount(tostring(p.cardId)),
    distinctPlayers = dcount(tostring(p.player))
    by day = startofday(timestamp)
| order by day desc
```

**Read as:** daily firing volume. A healthy engine fires this infrequently (mostly vintage HOFs with sparse top-grade comps); a sudden spike signals CH data quality drift or a new inverted comp cluster.

### Q2 — Top inverted (grader, grade-pair) clusters

```kql
traces
| where timestamp > ago(14d)
| where message contains "cross_observed_inversion_fired"
| extend p = parse_json(message)
| extend
    grader = tostring(p.grader),
    higherGrade = tostring(p.higherGrade),
    lowerGrade = tostring(p.lowerGrade),
    pct = todouble(p.inversionPctOriginal),
    ratio = todouble(p.ratio)
| summarize
    firings = count(),
    distinctCards = dcount(tostring(p.cardId)),
    medianInversionPct = percentile(pct, 50),
    medianReconRatio = percentile(ratio, 50)
    by grader, higherGrade, lowerGrade
| order by firings desc
| take 20
```

**Read as:** which grader + grade pairs invert most? PSA 10 < PSA 9 dominating is expected; BGS 9.5 < BGS 9 appearing prominently is worth investigating (suggests BGS-specific data quirk or pop-report-driven thin trading).

### Q3 — Vintage-year hotspots (CH FMV interpolation quirks)

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_observed_inversion_fired"
| extend p = parse_json(message)
| extend
    cardId = tostring(p.cardId),
    pct = todouble(p.inversionPctOriginal)
// Join card_id → year via a cards table or pricing snapshot (if available).
// Absent a joinable table, inspect cardId set externally.
| summarize
    firings = count(),
    medianInversionPct = percentile(pct, 50),
    p95InversionPct = percentile(pct, 95)
    by cardId
| where firings >= 3
| order by firings desc
| take 30
```

**Read as:** cards that repeatedly trigger the guard. 3+ firings on the same card across requests indicates the inversion is structural in CH's data, not a transient comp. Worth surfacing the year + set externally for prioritization.

### Q4 — By-player frequency (which HOFs are most affected?)

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_observed_inversion_fired"
| extend p = parse_json(message)
| extend
    player = tostring(p.player),
    pct = todouble(p.inversionPctOriginal)
| where isnotempty(player)
| summarize
    firings = count(),
    distinctCards = dcount(tostring(p.cardId)),
    medianInversionPct = percentile(pct, 50)
    by player
| order by firings desc
| take 25
```

**Read as:** the HOFs whose engine output most relies on the inversion guard. If Mantle / Mays / Aaron dominate, that's expected (low-volume PSA 10 vintage). Modern players appearing suggests CH's FMV interpolation has a systematic gap.

### Q5 — Reconstruction magnitude distribution

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_observed_inversion_fired"
| extend p = parse_json(message)
| extend
    originalMedian = todouble(p.originalHigherMedian),
    reconstructedMedian = todouble(p.reconstructedMedian),
    deltaUSD = reconstructedMedian - originalMedian,
    deltaPct = (reconstructedMedian - originalMedian) / originalMedian * 100
| summarize
    firings = count(),
    medianDeltaUSD = percentile(deltaUSD, 50),
    p95DeltaUSD = percentile(deltaUSD, 95),
    medianDeltaPct = percentile(deltaPct, 50),
    p95DeltaPct = percentile(deltaPct, 95)
| extend window = "last 30 days"
```

**Read as:** how much the guard moves the surfaced price. Median delta of \$500 is "guard is doing real work"; \$50 is noise. A wide p95 (e.g., \$10K+) flags vintage HOFs where the reconstruction is high-stakes.

### Q6 — Multi-pass firings (cascade inversions)

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_observed_inversion_fired"
| extend p = parse_json(message)
| extend passNumber = toint(p.passNumber)
| summarize firings = count() by passNumber
| order by passNumber asc
```

**Read as:** how often the multi-pass convergence fires. Pass 1 dominates by design; pass 2+ activity proves the cascade logic is doing real work (rare but meaningful — without multi-pass these would silently leave a cross-grader inversion uncorrected).

### Q7 — Safety-rail rejections (proposed but suppressed inversions)

> **Note:** This query is **NOT YET WIRABLE** — the guard does not currently emit events for combos that triggered a check but were rejected by the safety rails (compcount mismatch, sub-threshold inversion, missing premium). A follow-up CF could add a separate `cross_observed_inversion_skipped` event to track the rails' selectivity. Useful to validate threshold tuning (e.g., "are we missing real inversions because n>=3 floor is too strict?").

## Adding to the calibration dashboard

When importing as App Insights workbook tiles, group these under a new "Cross-Observed Inversion Guard" section. Stack vertically:

1. **Q1** as a daily count line chart (KPI: firings/day)
2. **Q2** as a bar chart top 20 (grader × grade-pair frequency)
3. **Q5** as a stat block (median + p95 delta USD)
4. **Q3** + **Q4** as drill-down tables linked from Q2

Pair with the existing `fmv_drift_observed` queries in [calibration-dashboard.md](./calibration-dashboard.md) — together they answer: "is the engine output diverging from CH, and is the inversion guard's correction landing in the right direction?"
