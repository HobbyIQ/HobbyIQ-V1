# ML Training Dataset Schema (FROZEN — Phase A)

**Status:** Frozen 2026-06-04 as part of CF-ML-MOAT Group C Phase A.
**Owner of source of truth:** [backend/src/services/mlTraining/trainingDatasetJoin.service.ts](../backend/src/services/mlTraining/trainingDatasetJoin.service.ts).
**Test gate:** [backend/tests/trainingDatasetJoin.test.ts](../backend/tests/trainingDatasetJoin.test.ts) asserts that the `features` key set in code exactly matches the FEATURES section below. Adding or removing a feature MUST update both the code constant `FEATURE_KEYS` and this doc; CI fails otherwise.

This doc defines the training dataset used for the Phase B price-prediction model. It exists so future work can train against a stable target shape, and so leakage cannot drift in unnoticed.

---

## Join definition

```
prediction_log         × prediction_outcomes
  PK /cardsightCardId      PK /cardsightCardId
  id format:               id = `${predictionDocId}__h${horizonDays}`
    resolved:              joined-on:
      `${cardsightCardId}_${epochMs}`    prediction_outcomes.predictionDocId
                                         == prediction_log.id
    sentinel (NEVER joined):
      `__unresolved___${sig}_${epochMs}`
```

**Filter:** `prediction_log.joinable === true` AND a matching outcome doc exists. Sentinel-partition predictions never get outcomes (the capture job filters `joinable=true` at candidate selection); the join naturally excludes them.

**Pair flagging:**
- `labelUsable = true` when `outcomeSource ∈ {cardsight_graded_window, cardsight_raw_window}` AND `realizedOutcomePrice !== null`.
- `labelUsable = false` with `excludeReason = "no_sales_in_window"` — TERMINAL row, no price. Excluded from price regression. **Kept** in the dataset as a liquidity signal for Phase B (separate model head can learn "will this card sell in horizon days?").
- `labelUsable = false` with `excludeReason = "not_found"` — card aged out of Cardsight catalog. Excluded from both heads.
- `labelUsable = false` with `excludeReason = "upstream_error"` — terminal Cardsight failure. Excluded.

---

## FEATURES (as-of prediction time)

All sourced from `prediction_log` only. Every value was knowable at prediction-emit time. **No post-prediction information may be added here.**

### Card identity
| Field | Type | Source | Notes |
|---|---|---|---|
| `playerName` | `string \| null` | `prediction_log.playerName` | High-cardinality categorical; Phase B encodes / hashes / target-encodes as it chooses. |
| `cardYear` | `number \| null` | `prediction_log.cardYear` | |
| `product` | `string \| null` | `prediction_log.product` | Set / product (e.g. "2024 Topps Chrome"). |
| `parallel` | `string \| null` | `prediction_log.parallel` | Resolved parallel name; null for base. |
| `gradeCompany` | `string \| null` | `prediction_log.gradeCompany` | "PSA" / "BGS" / "SGC" / "CGC" / null. |
| `gradeValue` | `number \| null` | `prediction_log.gradeValue` | Numeric grade; null for raw. |

### As-of-prediction pricing
| Field | Type | Source | Notes |
|---|---|---|---|
| `fairMarketValue` | `number \| null` | `prediction_log.fairMarketValue` | FMV anchor at prediction time. |
| `predictedPrice` | `number \| null` | `prediction_log.predictedPrice` | Forward prediction at prediction time. |
| `predictedPriceRangeLow` | `number \| null` | `prediction_log.predictedPriceRange.low` | Flattened from nested. |
| `predictedPriceRangeHigh` | `number \| null` | `prediction_log.predictedPriceRange.high` | Flattened from nested. |

### Engineering
| Field | Type | Source | Notes |
|---|---|---|---|
| `forwardProjectionFactor` | `number` | `prediction_log.forwardProjectionFactor` | Multiplier applied at prediction time. |

### TrendIQ — composite + per-layer multipliers + per-layer weights
| Field | Type | Source | Notes |
|---|---|---|---|
| `trendIQ_composite` | `number \| null` | `prediction_log.trendIQ_composite` / `trendIQ.composite` | Forward-looking composite multiplier, clamp(0.70, 1.50). |
| `trendIQ_playerMomentum` | `number \| null` | `prediction_log.playerMomentum_multiplier` / `trendIQ.components.playerMomentum.multiplier` | Layer-1 (attention) multiplier. |
| `trendIQ_cardTrajectory` | `number \| null` | `prediction_log.trendIQ.components.cardTrajectory.multiplier` | Layer-2 (card recent vs older). |
| `trendIQ_segmentTrajectory` | `number \| null` | `prediction_log.trendIQ.components.segmentTrajectory.multiplier` | Layer-3 (segment vs anchor). |
| `trendIQ_weight_playerMomentum` | `number \| null` | `prediction_log.trendIQ_weights.playerMomentum` / `trendIQ.weights.playerMomentum` | Fractional weight applied to L1 (sums-to-1 with the other two when present). |
| `trendIQ_weight_cardTrajectory` | `number \| null` | `prediction_log.trendIQ_weights.cardTrajectory` / `trendIQ.weights.cardTrajectory` | |
| `trendIQ_weight_segmentTrajectory` | `number \| null` | `prediction_log.trendIQ_weights.segmentTrajectory` / `trendIQ.weights.segmentTrajectory` | |

### Corpus quality (load-bearing for Phase B reliability scoring)
| Field | Type | Source | Notes |
|---|---|---|---|
| `compsUsed` | `number` | `prediction_log.compsUsed` | Number of comp sales the prediction consumed. |
| `cache_hit` | `boolean \| null` | `prediction_log.cache_hit` | Tri-state: null = no cache calls; true = all-cache-fresh; false = at least one miss. |
| `served_stale` | `boolean \| null` | `prediction_log.served_stale` | Tri-state companion. true = at least one cacheWrap call served a stale entry (Cardsight outage during prediction). |

---

## LABEL

Sourced from `prediction_outcomes`. The label is what Phase B trains against.

| Field | Type | Source | Notes |
|---|---|---|---|
| `realizedOutcomePrice` | `number \| null` | `prediction_outcomes.realizedOutcomePrice` | Median of in-window Cardsight sales. Null when `outcomeSource` is non-priced. |
| `realizedReturn` | `number \| null` | derived = `realizedOutcomePrice / fairMarketValue` | Lets Phase B train absolute OR relative target without re-derivation. Null when either numerator or denominator is null/zero. |
| `horizonDays` | `number` | `prediction_outcomes.horizonDays` | Days from prediction emit → window end. Tells Phase B which horizon model this row belongs to. |
| `outcomeSource` | `string` | `prediction_outcomes.outcomeSource` | One of: `cardsight_graded_window`, `cardsight_raw_window`, `no_sales_in_window`, `not_found`, `upstream_error`. |

---

## BASELINE (carried alongside; NOT fed to the model)

The price the shipped GPT-4o pipeline actually told the user. Phase B evals the ML model **vs realized** AND **vs this baseline** so we can answer "did the model beat the GPT-4o pipeline?"

| Field | Type | Source | Notes |
|---|---|---|---|
| `surfacedPrice` | `number \| null` | `prediction_log.surfacedPrice` | Headline price the user saw. Predicted-price first, fairMarketValue fallback. |
| `surfacedPriceSource` | `"predictedPrice" \| "fairMarketValue" \| "none"` | `prediction_log.surfacedPriceSource` | Tells eval which fallback path served the user-visible price. |

---

## METADATA (NOT features; join + debug only)

These fields are carried for traceability and join debugging. **They must never appear in the feature set.** Test asserts metadata key names do not collide with FEATURES.

| Field | Source | Purpose |
|---|---|---|
| `predictionDocId` | `prediction_log.id` | Join key; row provenance. |
| `outcomeDocId` | `prediction_outcomes.id` | Outcome row provenance. |
| `cardsightCardId` | shared partition key | Provenance + cross-row dedup. |
| `predictionTimestamp` | `prediction_log.timestamp` | Time-of-prediction (Phase B uses for train/test split by date). |
| `outcomeCapturedAt` | `prediction_outcomes.capturedAt` | When the outcome was written. |
| `userId` | `prediction_log.userId` | Source-of-prediction attribution. Nullable post-account-deletion. |
| `holdingId` | `prediction_log.holdingId` | Same. Nullable post-account-deletion. |
| `source` | `prediction_log.source` | One of the closed PredictionCorpusSource literal values (e.g. "estimate", "holding"). |
| `routedFromHolding` | `prediction_log.routedFromHolding` | §4.2/4.3 sale-join switch. Anonymized to false post-deletion. |

---

## LEAKAGE GUARD (asserted in tests)

The training dataset row is a four-section object with no overlapping keys:

```
{
  features:  { ...FEATURE_KEYS }     // FROM prediction_log; nothing post-prediction
  label:     { realizedOutcomePrice, realizedReturn, horizonDays, outcomeSource }
  baseline:  { surfacedPrice, surfacedPriceSource }
  metadata:  { predictionDocId, outcomeDocId, cardsightCardId,
               predictionTimestamp, outcomeCapturedAt, userId,
               holdingId, source, routedFromHolding }
  labelUsable:     boolean
  excludeReason:   "no_sales_in_window" | "not_found" | "upstream_error" | null
}
```

**Hard rules** (asserted in [backend/tests/trainingDatasetJoin.test.ts](../backend/tests/trainingDatasetJoin.test.ts)):

1. `Object.keys(row.features)` exactly equals `FEATURE_KEYS` — no extra fields, no missing fields.
2. **No** post-prediction field appears in `row.features`. Specifically: `realizedOutcomePrice`, `realizedReturn`, `nSalesInWindow`, `salesSample`, `windowEnd`, `outcomeSource`, `outcomeCapturedAt`, `captureRunId`, `captureAttempt`, `engineVersion` must NOT be present as feature keys.
3. `salesSample` is dropped entirely — never persisted onto the row in any section. (It carries individual sale prices that are downstream of the label's median; including it would let a model trivially memorize the median.)

---

## What gets excluded from the join AND why

| Source state | Excluded from join? | Reason |
|---|---|---|
| `prediction_log.joinable === false` (sentinel partition) | YES | No real `cardsightCardId` → no outcomes can be captured. |
| No matching `prediction_outcomes` doc exists yet | YES | Outcome capture hasn't run / hasn't matured to horizon. Will be picked up on a future export run. |
| `outcomeSource = "no_sales_in_window"` | NO — kept with `labelUsable=false` | Liquidity signal for Phase B's secondary head. |
| `outcomeSource = "not_found"` | NO — kept with `labelUsable=false` | Catalog-decay signal; informational for Phase B but not a price target. |
| `outcomeSource = "upstream_error"` (terminal at retry cap) | NO — kept with `labelUsable=false` | Documented failure mode; not a price target. |

---

## Versioning

This is **schema version 1** (Phase A). When Phase B finalizes, any change to FEATURES or LABEL bumps to version 2 and requires:

1. New `FEATURE_KEYS` constant + `TrainingDatasetFeatures` interface in the service.
2. New row-shape test asserting the v2 key set.
3. A migration note in this doc (don't rewrite history; append a versioned section).
4. Phase B model retraining (v1 weights are no longer comparable).
