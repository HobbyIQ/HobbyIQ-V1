# Sub-Raw + Cross-Grader Inversion Telemetry Queries

**Status:** Companion to [cross-observed-inversion-queries.md](./cross-observed-inversion-queries.md). Covers the two observation-only events shipped 2026-06-30:

- `sub_raw_inversion_observed` (CF-SUB-RAW-INVERSION-TELEMETRY, PR #205) — graded median < raw median (hot prospect speculation signal)
- `cross_grader_inversion_observed` (CF-CROSS-GRADER-INVERSION-TELEMETRY, PR #204) — same numeric grade, different graders, price disagreement (grader prestige drift)

Both are PURE OBSERVATION events — no engine behavior change. The signals feed seller intelligence + future targeted reconstruction CFs.

## Event shapes

### `sub_raw_inversion_observed`

```json
{
  "event": "sub_raw_inversion_observed",
  "source": "buildGradeBreakdown",
  "player": "Bobby Witt Jr.",
  "cardId": "...",
  "grader": "PSA",
  "grade": "9",
  "gradeMedian": 60,
  "gradeCount": 5,
  "rawMedian": 100,
  "marginPct": 40.0,
  "marginUSD": 40,
  "timestamp": "2026-06-30T..."
}
```

### `cross_grader_inversion_observed`

```json
{
  "event": "cross_grader_inversion_observed",
  "source": "buildGradeBreakdown",
  "player": "Mike Trout",
  "cardId": "...",
  "higherGrader": "BGS",
  "lowerGrader": "PSA",
  "numericGrade": "10",
  "higherMedian": 1000,
  "higherCount": 5,
  "lowerMedian": 500,
  "lowerCount": 12,
  "marginPct": 100.0,
  "timestamp": "2026-06-30T..."
}
```

Both emit from [marketRead.service.ts](../../src/services/compiq/marketRead.service.ts) via `buildGradeBreakdown`.

## Sub-Raw Queries (seller intelligence is the high-value angle)

### S1 — Top sub-raw prospects (hot speculation cards)

```kql
traces
| where timestamp > ago(14d)
| where message contains "sub_raw_inversion_observed"
| extend p = parse_json(message)
| extend
    player = tostring(p.player),
    cardId = tostring(p.cardId),
    marginPct = todouble(p.marginPct),
    marginUSD = todouble(p.marginUSD),
    rawMedian = todouble(p.rawMedian),
    gradeMedian = todouble(p.gradeMedian)
| where isnotempty(player)
| summarize
    firings = count(),
    distinctCards = dcount(cardId),
    medianMarginPct = percentile(marginPct, 50),
    medianRawMedian = percentile(rawMedian, 50),
    medianGradeMedian = percentile(gradeMedian, 50)
    by player
| order by firings desc
| take 30
```

**Read as:** **THIS IS THE SELLER-INTELLIGENCE CORE QUERY.** Players whose raw cards trade above their graded cards are pure speculation — the market is buying the lottery ticket on a future PSA 10 grade. High firings + large margin = hot speculation signal. Drew's product can highlight these in DailyIQ.

### S2 — Margin trend over time (market regime indicator)

```kql
traces
| where timestamp > ago(90d)
| where message contains "sub_raw_inversion_observed"
| extend p = parse_json(message)
| extend marginPct = todouble(p.marginPct)
| summarize
    firings = count(),
    medianMarginPct = percentile(marginPct, 50),
    p75MarginPct = percentile(marginPct, 75),
    p95MarginPct = percentile(marginPct, 95)
    by week = startofweek(timestamp)
| order by week desc
```

**Read as:** widening sub-raw margins across the market = speculation heating up (bullish). Narrowing = market cooling. Track week-over-week. The p95 line is the "extreme speculation" signal — single players going parabolic vs the broad market.

### S3 — Grader breakdown (which grade-tier traded below raw most?)

```kql
traces
| where timestamp > ago(30d)
| where message contains "sub_raw_inversion_observed"
| extend p = parse_json(message)
| extend
    grader = tostring(p.grader),
    grade = tostring(p.grade)
| summarize
    firings = count(),
    distinctCards = dcount(tostring(p.cardId))
    by grader, grade
| order by firings desc
| take 20
```

**Read as:** PSA 8 / 9 dominating is expected (raw chase > slabbed bottom-grade). BGS 9 / SGC 9 prominence is a grader-prestige drift signal — that grader's mid grades are being valued less than the underlying raw card.

### S4 — Year-scope hotspots (which release year drives the most speculation?)

```kql
// Requires cardId → year join (via a cards reference table). If absent,
// inspect the top-cards from S1 externally.
traces
| where timestamp > ago(30d)
| where message contains "sub_raw_inversion_observed"
| extend p = parse_json(message)
| extend cardId = tostring(p.cardId)
| summarize firings = count(), avgMarginPct = avg(todouble(p.marginPct)) by cardId
| order by firings desc
| take 50
```

**Read as:** cards repeatedly firing sub-raw events are the high-volume speculation targets. Cross-reference with the product's "watchlist" cohort.

## Cross-Grader Queries

### C1 — Top grader-pair disagreements

```kql
traces
| where timestamp > ago(14d)
| where message contains "cross_grader_inversion_observed"
| extend p = parse_json(message)
| extend
    higherGrader = tostring(p.higherGrader),
    lowerGrader = tostring(p.lowerGrader),
    numericGrade = tostring(p.numericGrade),
    marginPct = todouble(p.marginPct)
| summarize
    firings = count(),
    distinctCards = dcount(tostring(p.cardId)),
    medianMarginPct = percentile(marginPct, 50),
    p95MarginPct = percentile(marginPct, 95)
    by higherGrader, lowerGrader, numericGrade
| order by firings desc
| take 25
```

**Read as:** which grader-pairs disagree most at each tier? Examples to look for:
- **BGS 10 > PSA 10 (large margin)** = BGS 10 Black Label premium signal (real)
- **CGC 10 > PSA 10** = CGC's increasing prestige (real, recent trend)
- **PSA 9 > BGS 9 (consistently)** = PSA grading is stricter (real)
- **SGC 10 > PSA 10 (small margin)** = noise or grader-specific demand pocket

Use this to decide which cross-grader inversions are REAL market signals vs CH data quirks worth reconstructing.

### C2 — Cross-grader margin trends (prestige drift)

```kql
traces
| where timestamp > ago(90d)
| where message contains "cross_grader_inversion_observed"
| extend p = parse_json(message)
| extend
    higherGrader = tostring(p.higherGrader),
    lowerGrader = tostring(p.lowerGrader),
    marginPct = todouble(p.marginPct)
| summarize
    firings = count(),
    medianMarginPct = percentile(marginPct, 50)
    by week = startofweek(timestamp), higherGrader, lowerGrader
| where firings >= 5
| order by week desc, firings desc
```

**Read as:** if CGC vs PSA margin is widening week-over-week, CGC's prestige is rising (or PSA's is falling — same signal). This feeds the cross-grader reconstruction follow-up: only reconstruct grader pairs whose margin is STABLE (clear data quirk); leave drifting pairs alone (real market regime).

### C3 — Magnitude distribution (small vs large disagreements)

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_grader_inversion_observed"
| extend p = parse_json(message)
| extend marginPct = todouble(p.marginPct)
| summarize
    firings = count(),
    pct_5to10 = countif(marginPct < 10),
    pct_10to25 = countif(marginPct >= 10 and marginPct < 25),
    pct_25to50 = countif(marginPct >= 25 and marginPct < 50),
    pct_50to100 = countif(marginPct >= 50 and marginPct < 100),
    pct_100plus = countif(marginPct >= 100)
```

**Read as:** small disagreements (<10%) are likely noise; large ones (50%+) are structural prestige signals OR data quirks. The 100%+ bucket is "the higher-prestige slab trades at 2× the lower" — almost certainly real market signal (BGS Black Label, Pristine, etc.).

### C4 — By-card repeat offenders

```kql
traces
| where timestamp > ago(30d)
| where message contains "cross_grader_inversion_observed"
| extend p = parse_json(message)
| extend
    cardId = tostring(p.cardId),
    higherGrader = tostring(p.higherGrader),
    lowerGrader = tostring(p.lowerGrader)
| summarize firings = count() by cardId, higherGrader, lowerGrader
| where firings >= 3
| order by firings desc
```

**Read as:** cards consistently triggering the same grader-pair inversion across requests = stable market signal (NOT a transient comp). High-confidence input for the reconstruction-cohort decision.

## Recommended dashboard slots

Extend the existing `Cross-Observed Inversion Guard` section of the dashboard with two more groups:

1. **Sub-Raw Speculation Signals** (high product value)
   - S1 stat: "Top 10 hot prospects by firings" (linked to DailyIQ candidate list)
   - S2 line chart: "Weekly median sub-raw margin" (regime indicator)
   - S3 bar: "Sub-raw grader breakdown" (calibration QA)

2. **Cross-Grader Prestige Disagreement** (calibration intelligence)
   - C1 table: "Top grader-pair disagreements"
   - C2 line chart: "Margin trends per grader-pair"
   - C3 histogram: "Magnitude distribution"
   - C4 stat: "Stable repeat-offender cards" (input for reconstruction CF)

Together with the `cross_observed_inversion_fired` queries, you have three complementary lenses:
- **Same-grader inversions** = data integrity (reconstruction live)
- **Cross-grader inversions** = market prestige signal (observation only, future reconstruction)
- **Sub-raw inversions** = speculation signal (observation only, product layer)
