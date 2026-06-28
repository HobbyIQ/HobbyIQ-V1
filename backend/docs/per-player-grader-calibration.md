# Per-Player Grader Multiplier Calibration

**Status:** Step 1 (telemetry wiring) shipped. Steps 2-5 (aggregation, override storage, engine consumption, refresh job) are follow-ups awaiting accumulated data.

---

## Why

Our default grader multipliers (`GRADER_PREMIUMS` in `compiqEstimate.service.ts`) come from a single dataset — the Prospects Live MiLB pitching-prospect sample (n≈60). It's a defensible baseline but:

1. Hitters' PSA 10 multipliers are documented to differ from pitchers'.
2. Veteran/established players don't follow the prospect curve.
3. Per-player heat (recent hype, recent slumps, off-field events) creates dispersion the static table can't capture.
4. The sample is small. Wide confidence intervals.

**Goal:** observe (raw, graded) sale pairs over time and derive per-player multipliers that override the static table once the sample is meaningful.

---

## Pipeline

```
[engine priced response]
        │
        │  CF-CH-WIRE-GRADER-RATIO-TELEMETRY
        ▼
[graded_ratio_observed App Insights event]
        │
        │  (KQL aggregation, weekly)
        ▼
[per-player override table in Cosmos]
        │
        │  engine consults overrides FIRST,
        │  falls back to tiered defaults
        ▼
[priced response uses player-tuned multiplier]
```

---

## Step 1 — Telemetry (SHIPPED via CF-CH-WIRE-GRADER-RATIO-TELEMETRY)

`compileGradedEstimatesForCard` emits one `graded_ratio_observed` event per observed (raw, graded) pair on each priced response. Payload:

```json
{
  "event": "graded_ratio_observed",
  "source": "compiq.price-by-id.observed-pair",
  "player": "Eric Hartman",
  "cardId": "1778542140951x...",
  "gradingCompany": "PSA",
  "grade": "10",
  "rawAnchor": 50.00,
  "gradedValue": 175.00,
  "ratio": 3.5,
  "tier": "50-100",
  "timestamp": "2026-06-28T13:48:21.234Z"
}
```

Observation gate: BOTH a raw median AND a graded median must exist in the same card's `gradeBreakdown`. Composed/projected anchors are excluded (they'd produce circular ratios = the multiplier we're already using).

---

## Step 2 — KQL aggregation query

Run in the `hobbyiq-insights` App Insights resource. Returns per-(player, grade, tier) observed median ratio with sample size, suitable for materializing into the override table.

```kql
traces
| where timestamp > ago(30d)
| where message has "graded_ratio_observed"
| extend payload = parse_json(message)
| where tostring(payload.event) == "graded_ratio_observed"
| project
    timestamp,
    player        = tostring(payload.player),
    cardId        = tostring(payload.cardId),
    grader        = tostring(payload.gradingCompany),
    grade         = tostring(payload.grade),
    tier          = tostring(payload.tier),
    rawAnchor     = todouble(payload.rawAnchor),
    gradedValue   = todouble(payload.gradedValue),
    ratio         = todouble(payload.ratio)
| where isnotempty(player) and ratio > 0 and ratio < 100   // strip outliers + null rows
// Per-(player, company, grade, tier) aggregation
| summarize
    samples          = dcount(cardId),
    observations     = count(),
    medianRatio      = percentile(ratio, 50),
    p25Ratio         = percentile(ratio, 25),
    p75Ratio         = percentile(ratio, 75),
    minRatio         = min(ratio),
    maxRatio         = max(ratio),
    lastObservedAt   = max(timestamp)
    by player, grader, grade, tier
// Sample-size gate — below 5 distinct cards, we don't trust the median yet
| where samples >= 5
| order by player asc, grader asc, grade asc, tier asc
```

Quick-look variant (no sample-size gate, for exploration):

```kql
traces
| where timestamp > ago(7d)
| where message has "graded_ratio_observed"
| extend payload = parse_json(message)
| where tostring(payload.event) == "graded_ratio_observed"
| extend player = tostring(payload.player), grader = tostring(payload.gradingCompany), grade = tostring(payload.grade), ratio = todouble(payload.ratio)
| summarize n = count(), medianRatio = percentile(ratio, 50) by player, grader, grade
| order by n desc
```

---

## Step 3 — Cosmos override table (FUTURE CF)

**Container:** `playerGradeOverrides`
**Partition key:** `/player`
**TTL:** none (rows are intentionally durable)

Document shape:

```json
{
  "id": "Eric Hartman|PSA|10|50-100",
  "player": "Eric Hartman",
  "gradingCompany": "PSA",
  "grade": "10",
  "tier": "50-100",
  "medianRatio": 3.21,
  "samples": 8,
  "p25Ratio": 2.84,
  "p75Ratio": 3.47,
  "lastRefreshedAt": "2026-07-05T00:00:00.000Z"
}
```

`id` composed from the four-tuple to make upserts idempotent.

---

## Step 4 — Engine consumption (FUTURE CF)

Modify `getGraderPremium(company, grade, rawPrice)` in `compiqEstimate.service.ts`:

```ts
export async function getGraderPremium(
  company, grade, rawPrice?, playerName?
): number {
  // 1. Per-player override (if player provided AND sample size meets threshold)
  if (playerName) {
    const override = await readPlayerOverride(playerName, company, grade, tierOf(rawPrice));
    if (override && override.samples >= MIN_SAMPLES_FOR_OVERRIDE) {
      return override.medianRatio;
    }
  }
  // 2. Tiered default (current behavior — fallback)
  return GRADER_PREMIUMS[company][grade][tierOf(rawPrice)];
}
```

`MIN_SAMPLES_FOR_OVERRIDE` start at 5 distinct cards observed. Raise as data accumulates.

The function becoming async means callers need to be updated — non-trivial but mechanical.

---

## Step 5 — Periodic refresh (FUTURE CF)

Azure Function on a weekly cron:

1. Run the Step 2 KQL via the App Insights API.
2. For each result row, upsert into `playerGradeOverrides`.
3. Log `playerGradeOverride_refresh_complete` with `rowsUpserted`, `rowsSkipped` (sample size < threshold), `runtimeMs`.

Initial cadence: weekly on Sunday at 02:00 UTC. Adjust if data volume warrants more or less.

---

## Sources

- [Prospects Live — Pitchers, Hitters, and PSA Grades](https://www.prospectslive.com/pitchers-hitters-and-psa-grades-the-psa-grading-multiplier-for-milb-prospect-cards/)
- [Dahl Does Cards mirror](https://dahldoescards.substack.com/p/pitchers-hitters-and-psa-grades-the)
- CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28) — the baseline table this calibration overrides
- CF-CH-WIRE-GRADER-RATIO-TELEMETRY (2026-06-28) — Step 1 telemetry, this CF
