# HobbyIQ ML Calibration Architecture

**Status:** First iteration shipping with CF-AUTO-AWARE-MULTIPLIERS (2026-06-28). Subsequent CFs build out the self-refreshing pipeline.

## Why

Per Drew's framing: "scalable trustworthy product with the best approach… ML to get better and better with time."

HobbyIQ's pricing engine combines comp aggregation (recent sales) with multiplier-based estimation (grade, parallel, autograph, vintage). Static multiplier tables go stale as the market evolves. A trustworthy product must self-correct as new evidence arrives.

This document describes the calibration loop that lets the engine improve continuously from observed market data, with no manual table updates required after the initial wiring.

---

## The loop

```
   ┌──────────────────────────────────────────────────────────────────┐
   │ 1. OBSERVE                                                       │
   │    Every priced response emits structured telemetry:             │
   │      - graded_ratio_observed       (CF-CH-WIRE-GRADER-RATIO)     │
   │      - fmv_drift_observed          (CF-CH-FMV-CROSS-VALIDATE)    │
   │      - sales_momentum_observed     (CF-CH-TREND-INGEST)          │
   │      - nearest_graded_anchor_      (CF-CH-NEAREST-GRADED-ANCHOR) │
   │        surfaced                                                  │
   └────────────────────────┬─────────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 2. AGGREGATE                                                     │
   │    Weekly Azure Function runs KQL aggregations + CH scans:       │
   │      - Per-(player, parallel, grade-tier) median ratio           │
   │      - Per-(card-family, raw-tier, grade) auto multiplier        │
   │      - Per-(player) sales-momentum trajectory                    │
   └────────────────────────┬─────────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 3. CALIBRATE                                                     │
   │    Statistical compression with σ-damping & freshness weighting: │
   │      - trimmed median (Q5-Q95 outlier trim)                      │
   │      - sample-size confidence band                               │
   │      - decay weighting (recent obs > older obs)                  │
   └────────────────────────┬─────────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 4. PERSIST                                                       │
   │    Upsert calibration tables into Cosmos:                        │
   │      - autoMultipliers      (this CF)                            │
   │      - playerGradeOverrides (per-player-grader-calibration.md)   │
   │      - parallelPremiums     (future CF)                          │
   │    Each row carries `calibratedAt` + `sampleSize` for audit.     │
   └────────────────────────┬─────────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 5. CONSUME                                                       │
   │    Engine reads latest tables on each pricing call:              │
   │      - getGraderPremium(company, grade, rawPrice, cardClass)     │
   │        consults autoMultipliers when cardClass="autograph",      │
   │        falls back to GRADER_PREMIUMS for base cards              │
   │      - deriveGradeLadderAnchor activates cross-grade conversion  │
   │        once the calibrated table covers the requested tier       │
   └────────────────────────┬─────────────────────────────────────────┘
                            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 6. VALIDATE                                                      │
   │    Continuous A/B comparison:                                    │
   │      - fmv_drift_observed.ratio post-calibration vs pre-         │
   │      - Per-week calibration impact dashboard                     │
   │      - Backtest harness rejects calibration runs that regress    │
   └──────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                  (loop back to step 1)
```

The loop closes: every priced response becomes evidence for the next calibration.

---

## Current state (2026-06-28)

| Loop step | Status | Notes |
|---|---|---|
| 1. Observe (graded_ratio_observed) | SHIPPED | CF-CH-WIRE-GRADER-RATIO-TELEMETRY |
| 1. Observe (fmv_drift_observed) | SHIPPED | CF-CH-FMV-CROSS-VALIDATE |
| 1. Observe (sales_momentum_observed) | SHIPPED | CF-CH-TREND-INGEST |
| 1. Observe (nearest_graded_anchor_surfaced) | SHIPPED | CF-CH-NEAREST-GRADED-ANCHOR (#164) |
| 2. Aggregate (KQL queries) | DOCUMENTED | per-player-grader-calibration.md Step 2 |
| 3. Calibrate (auto multipliers) | IN PROGRESS | CF-AUTO-AWARE-MULTIPLIERS — scan script ships first; weekly refresh follows |
| 3. Calibrate (player overrides) | PLAN | Awaiting ~7d telemetry accumulation |
| 4. Persist (Cosmos containers) | PLAN | autoMultipliers + playerGradeOverrides |
| 5. Consume (engine reads) | PLAN | getGraderPremium delegates to override table when present |
| 6. Validate (A/B) | PLAN | Per-week drift dashboard once data accumulates |

---

## CF roadmap

Each CF advances the loop, tested independently, shipped without blocking the rest:

1. **CF-AUTO-AWARE-MULTIPLIERS** (THIS CF): one-off scan script generates initial autograph multiplier table; commit as JSON; engine consumes via new getter that prefers the empirical table for cards detected as autographs.

2. **CF-AUTO-MULTIPLIER-REFRESH-JOB**: Azure Function on weekly cron re-runs the scan, upserts to Cosmos `autoMultipliers` container, engine reads the latest. Calibration becomes self-refreshing.

3. **CF-PLAYER-GRADE-OVERRIDES** (depends on ~7d graded_ratio_observed): aggregate per-player ratios, upsert to `playerGradeOverrides`, getGraderPremium prefers player-specific over generic-auto.

4. **CF-CALIBRATION-VALIDATION-DASHBOARD**: KQL workbook tracking weekly drift improvements; alerts when a calibration run REGRESSES vs prior week (gate the refresh).

5. **CF-PARALLEL-PREMIUM-CALIBRATION**: same architecture for the chromeDraftMultipliers worksheet — replace hand-maintained `baseRelativePremium` values with empirical aggregation. Solves the "Kurtz Green Lava 2025 not in worksheet" class indefinitely.

---

## Storage contract

### `autoMultipliers` (Cosmos)
**Partition key:** `/company`
**TTL:** none (rows are intentionally durable — replaced by upserts)

```json
{
  "id": "PSA|10|100-250",
  "company": "PSA",
  "grade": "10",
  "rawTier": "100-250",
  "cardClass": "autograph",
  "ratio": 3.85,
  "sampleSize": 47,
  "trimmedMedianRatio": 3.85,
  "fullMedianRatio": 3.92,
  "ratioP25": 3.10,
  "ratioP75": 4.50,
  "calibratedAt": "2026-06-28T18:00:00.000Z",
  "calibrationRunId": "cal-2026-06-28-1"
}
```

### `playerGradeOverrides` (Cosmos)
**Partition key:** `/player`
**TTL:** none

```json
{
  "id": "Nick Kurtz|PSA|10|100-250",
  "player": "Nick Kurtz",
  "company": "PSA",
  "grade": "10",
  "rawTier": "100-250",
  "ratio": 4.10,
  "sampleSize": 7,
  "calibratedAt": "..."
}
```

Lookup order in `getGraderPremium`:
1. `playerGradeOverrides` by `(player, company, grade, tier)` — most specific
2. `autoMultipliers` by `(company, grade, tier)` when card is auto-class
3. Static `GRADER_PREMIUMS` baseline (current behavior, base-card calibrated)

Cardinality cap: any override row with `sampleSize < 3` is treated as missing — too thin to trust.

---

## Trustworthiness guardrails

The loop CAN drift if not guarded. Each refresh run must pass:

1. **Sanity floor:** every published ratio must be within [0.5×, 1.5×] of the prior week's published ratio. Larger swings are flagged and the run is skipped, awaiting human review (next CF).

2. **Sample size floor:** ratios with N < 3 are NOT published — they fall through to the prior tier's value.

3. **Outlier trim:** trimmed median (drop Q5/Q95) on every aggregation. Single rogue comps can't move the published ratio.

4. **Cross-source validation:** compare engine FMV pre-calibration vs post-calibration vs CH `card-fmv` for a held-out set of N cards. If post-calibration drift INCREASES, the run is rejected.

5. **Audit trail:** every published row carries `calibratedAt` + `calibrationRunId`. iOS debug overlay (future CF) can show "FMV calibration is 3 days old, sample size 47".

These guards turn "self-improving" into "monotonically self-improving" — a calibration that performs worse than the prior one is rejected, not deployed.

---

## Why this beats CardHedge's static table

CH publishes one FMV per card. Their internal calibration is opaque (we know they use σ-damped player-level index but not the multiplier table updates). Our system:

- **Per-player corrections** that CH does not publish — collected from OUR observed sales pairs.
- **Cascade-aware momentum** (CF-CH-TREND-INGEST telemetry already shipping) layered on top of CH's player index — engaged-fan-tier signals fire before CH's player index reflects them.
- **Transparent audit trail** — every FMV carries `fmvSource`, `fmvAnchorGrade`, `fmvAnchorDaysOld`, `fmvConfidence`. iOS users see the math.
- **Open refresh cadence** — weekly today; could become daily for high-value cards (next CF).

CH is the data source. HobbyIQ is the engine.
