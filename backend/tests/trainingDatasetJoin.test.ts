// CF-ML-MOAT GROUP C PHASE A (2026-06-04): training-dataset join service tests.
//
// Pins the FROZEN row shape + the leakage invariant. Phase B can rely on
// the shape these tests assert; any future PR that drifts the schema
// without updating both code + docs fails here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";

import {
  joinTrainingDataset,
  FEATURE_KEYS,
  _resetForTests,
  _seedOutcomeForTests,
  _seedPredictionForTests,
} from "../src/services/mlTraining/trainingDatasetJoin.service";
import type { OutcomeDoc } from "../src/services/outcomes/predictionOutcomes.service";

const CARD_ID = "card-1";

function makePrediction(overrides: Record<string, unknown> = {}): any {
  return {
    id: "pred-1",
    cardsightCardId: CARD_ID,
    joinable: true,
    predictionDirection: "stable",
    playerName: "Test Player",
    cardYear: 2024,
    product: "2024 Topps Chrome",
    parallel: null,
    gradeCompany: "PSA",
    gradeValue: 10,
    fairMarketValue: 100,
    fmvMechanism: "main-pipeline",
    surfacedPrice: 110,
    surfacedPriceSource: "predictedPrice",
    predictedPrice: 110,
    predictedPriceRange: { low: 100, high: 120 },
    predictedPriceMechanism: "trendiq-projection",
    forwardProjectionFactor: 1.1,
    trendIQ: {
      composite: 1.05,
      direction: "up",
      coverage: "full",
      components: {
        playerMomentum: { multiplier: 1.02, flags: [], componentSignals: {}, lastUpdated: null, sourceUrl: null },
        cardTrajectory: { multiplier: 1.04, pctChange: 4, recentMedian: 100, olderMedian: 96, recentCount: 5, olderCount: 5, windowRecentDays: 14, windowOlderDays: 30 },
        segmentTrajectory: { multiplier: 1.06, pctChange: 6, effectiveAnchorDate: "2026-01-01", originalAnchorDate: "2026-01-01", windowDays: 60, preAnchorMedian: 90, postAnchorMedian: 95, preAnchorCount: 10, postAnchorCount: 12, siblingsScanned: 8, totalSamples: 22 },
      },
      weights: { playerMomentum: 0.3, cardTrajectory: 0.4, segmentTrajectory: 0.3 },
      lastUpdated: "2026-06-01T00:00:00Z",
    },
    compsUsed: 25,
    timestamp: "2026-05-01T00:00:00Z",
    source: "estimate",
    userId: "u-1",
    holdingId: "h-1",
    routedFromHolding: true,
    cache_hit: false,
    served_stale: false,
    // Phase 4B flat hoists
    trendIQ_composite: 1.05,
    playerMomentum_multiplier: 1.02,
    trendIQ_weights: { playerMomentum: 0.3, cardTrajectory: 0.4, segmentTrajectory: 0.3 },
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<OutcomeDoc> = {}): OutcomeDoc {
  return {
    id: "pred-1__h30",
    predictionDocId: "pred-1",
    cardsightCardId: CARD_ID,
    predictionTimestamp: "2026-05-01T00:00:00Z",
    horizonDays: 30,
    windowStart: "2026-05-01T00:00:00Z",
    windowEnd: "2026-05-31T00:00:00Z",
    outcomeSource: "cardsight_graded_window",
    realizedOutcomePrice: 125,
    realizedOutcomeAggregation: "median",
    nSalesInWindow: 4,
    salesSample: [{ price: 120, date: "2026-05-10" }, { price: 130, date: "2026-05-20" }],
    capturedAt: "2026-06-01T00:00:00Z",
    captureRunId: "run-1",
    captureAttempt: 1,
    engineVersion: "v1",
    schemaVersion: 1,
    docType: "prediction_outcome",
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
});

describe("trainingDatasetJoin — row-shape lock", () => {
  it("produces a row with exactly the four documented sections + flags", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome());

    const { rows, summary } = await joinTrainingDataset();
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Top-level keys.
    expect(Object.keys(row).sort()).toEqual(
      ["baseline", "excludeReason", "features", "label", "labelUsable", "metadata"].sort(),
    );

    // Features keys EXACTLY match FEATURE_KEYS (no extras, no missing).
    expect(Object.keys(row.features).sort()).toEqual([...FEATURE_KEYS].sort());

    // Label, baseline, metadata key sets.
    expect(Object.keys(row.label).sort()).toEqual(
      ["horizonDays", "outcomeSource", "realizedOutcomePrice", "realizedReturn"],
    );
    expect(Object.keys(row.baseline).sort()).toEqual(
      ["surfacedPrice", "surfacedPriceSource"],
    );
    expect(Object.keys(row.metadata).sort()).toEqual(
      [
        "cardsightCardId",
        "holdingId",
        "outcomeCapturedAt",
        "outcomeDocId",
        "predictionDocId",
        "predictionTimestamp",
        "routedFromHolding",
        "source",
        "userId",
      ],
    );

    // Sanity-check a few mapped values.
    expect(row.features.playerName).toBe("Test Player");
    expect(row.features.trendIQ_composite).toBe(1.05);
    expect(row.features.trendIQ_playerMomentum).toBe(1.02);
    expect(row.features.trendIQ_cardTrajectory).toBe(1.04);
    expect(row.features.trendIQ_segmentTrajectory).toBe(1.06);
    expect(row.features.trendIQ_weight_playerMomentum).toBe(0.3);
    expect(row.features.predictedPriceRangeLow).toBe(100);
    expect(row.features.predictedPriceRangeHigh).toBe(120);
    expect(row.label.realizedOutcomePrice).toBe(125);
    expect(row.label.realizedReturn).toBe(125 / 100);
    expect(row.label.horizonDays).toBe(30);
    expect(row.baseline.surfacedPrice).toBe(110);

    expect(summary.totalOutcomes).toBe(1);
    expect(summary.joined).toBe(1);
    expect(summary.labelUsableGraded).toBe(1);
  });
});

describe("trainingDatasetJoin — leakage guard", () => {
  it("features section contains NO post-prediction field names", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome());
    const { rows } = await joinTrainingDataset();
    const featureKeySet = new Set(Object.keys(rows[0].features));

    // None of these post-prediction fields may appear as feature keys.
    const FORBIDDEN = [
      "realizedOutcomePrice",
      "realizedReturn",
      "nSalesInWindow",
      "salesSample",
      "windowEnd",
      "outcomeSource",
      "outcomeCapturedAt",
      "captureRunId",
      "captureAttempt",
      "engineVersion",
      "horizonDays",
    ];
    for (const k of FORBIDDEN) {
      expect(featureKeySet.has(k), `feature key set must not contain '${k}'`).toBe(false);
    }
  });

  it("salesSample is dropped — never present anywhere on the row", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome());
    const { rows } = await joinTrainingDataset();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized.includes("salesSample")).toBe(false);
  });

  it("FEATURE_KEYS contains no post-prediction string literals (compile-time-ish check)", () => {
    const set = new Set(FEATURE_KEYS as readonly string[]);
    const FORBIDDEN = [
      "realizedOutcomePrice",
      "realizedReturn",
      "salesSample",
      "outcomeSource",
      "horizonDays",
      "nSalesInWindow",
    ];
    for (const k of FORBIDDEN) {
      expect(set.has(k), `FEATURE_KEYS must not contain '${k}'`).toBe(false);
    }
  });
});

describe("trainingDatasetJoin — flagging", () => {
  it("flags cardsight_graded_window with price as labelUsable=true", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome({ outcomeSource: "cardsight_graded_window", realizedOutcomePrice: 125 }));
    const { rows, summary } = await joinTrainingDataset();
    expect(rows[0].labelUsable).toBe(true);
    expect(rows[0].excludeReason).toBeNull();
    expect(summary.labelUsableGraded).toBe(1);
    expect(summary.labelUsableRaw).toBe(0);
  });

  it("flags cardsight_raw_window with price as labelUsable=true", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome({ outcomeSource: "cardsight_raw_window", realizedOutcomePrice: 50 }));
    const { rows, summary } = await joinTrainingDataset();
    expect(rows[0].labelUsable).toBe(true);
    expect(rows[0].excludeReason).toBeNull();
    expect(summary.labelUsableRaw).toBe(1);
    expect(summary.labelUsableGraded).toBe(0);
  });

  it("flags no_sales_in_window as labelUsable=false, KEPT in result (liquidity signal)", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome({
      outcomeSource: "no_sales_in_window",
      realizedOutcomePrice: null,
      realizedOutcomeAggregation: null,
      nSalesInWindow: 0,
      salesSample: [],
    }));
    const { rows, summary } = await joinTrainingDataset();
    expect(rows).toHaveLength(1);
    expect(rows[0].labelUsable).toBe(false);
    expect(rows[0].excludeReason).toBe("no_sales_in_window");
    expect(rows[0].label.realizedOutcomePrice).toBeNull();
    expect(rows[0].label.realizedReturn).toBeNull();
    expect(summary.noSalesInWindow).toBe(1);
    expect(summary.labelUsableGraded).toBe(0);
    expect(summary.labelUsableRaw).toBe(0);
  });

  it("flags not_found as labelUsable=false with excludeReason=not_found", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome({
      outcomeSource: "not_found",
      realizedOutcomePrice: null,
    }));
    const { rows, summary } = await joinTrainingDataset();
    expect(rows[0].labelUsable).toBe(false);
    expect(rows[0].excludeReason).toBe("not_found");
    expect(summary.notFound).toBe(1);
  });

  it("flags upstream_error as labelUsable=false with excludeReason=upstream_error", async () => {
    _seedPredictionForTests(makePrediction());
    _seedOutcomeForTests(makeOutcome({
      outcomeSource: "upstream_error",
      realizedOutcomePrice: null,
    }));
    const { rows, summary } = await joinTrainingDataset();
    expect(rows[0].labelUsable).toBe(false);
    expect(rows[0].excludeReason).toBe("upstream_error");
    expect(summary.upstreamError).toBe(1);
  });

  it("flags labelUsable=false when realizedOutcomePrice is null even on a window source", async () => {
    _seedPredictionForTests(makePrediction());
    // Defensive: a window source with null price shouldn't happen at write
    // time (the outcomes service writes "no_sales_in_window" when prices
    // are empty), but if it ever did, the join must NOT pretend it's a
    // label.
    _seedOutcomeForTests(makeOutcome({
      outcomeSource: "cardsight_graded_window",
      realizedOutcomePrice: null,
    }));
    const { rows } = await joinTrainingDataset();
    expect(rows[0].labelUsable).toBe(false);
  });
});

describe("trainingDatasetJoin — null-handling", () => {
  it("doesn't crash when prediction fields are mostly null", async () => {
    _seedPredictionForTests(makePrediction({
      playerName: null,
      cardYear: null,
      product: null,
      parallel: null,
      gradeCompany: null,
      gradeValue: null,
      fairMarketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      surfacedPrice: null,
      surfacedPriceSource: "none",
      compsUsed: 0,
      cache_hit: null,
      served_stale: null,
      trendIQ_composite: null,
      playerMomentum_multiplier: null,
      trendIQ_weights: null,
      trendIQ: {
        composite: 1.0,
        direction: "flat",
        coverage: "insufficient",
        components: { playerMomentum: null, cardTrajectory: null, segmentTrajectory: null },
        weights: null,
        lastUpdated: null,
      },
    }));
    _seedOutcomeForTests(makeOutcome());
    const { rows } = await joinTrainingDataset();
    expect(rows).toHaveLength(1);
    expect(rows[0].features.playerName).toBeNull();
    expect(rows[0].features.cardYear).toBeNull();
    expect(rows[0].features.fairMarketValue).toBeNull();
    expect(rows[0].features.trendIQ_playerMomentum).toBeNull();
    expect(rows[0].features.trendIQ_cardTrajectory).toBeNull();
    expect(rows[0].features.trendIQ_weight_playerMomentum).toBeNull();
    expect(rows[0].features.cache_hit).toBeNull();
    // realizedReturn must be null when FMV is null
    expect(rows[0].label.realizedReturn).toBeNull();
  });

  it("realizedReturn is null when fairMarketValue is 0 (avoid divide-by-zero)", async () => {
    _seedPredictionForTests(makePrediction({ fairMarketValue: 0 }));
    _seedOutcomeForTests(makeOutcome({ realizedOutcomePrice: 100 }));
    const { rows } = await joinTrainingDataset();
    expect(rows[0].label.realizedReturn).toBeNull();
  });

  it("unmatched outcome (no prediction with that predictionDocId) increments summary.unmatched", async () => {
    _seedOutcomeForTests(makeOutcome({ predictionDocId: "ghost-pred" }));
    const { rows, summary } = await joinTrainingDataset();
    expect(rows).toHaveLength(0);
    expect(summary.unmatched).toBe(1);
    expect(summary.joined).toBe(0);
    expect(summary.totalOutcomes).toBe(1);
  });

  it("prediction.joinable === false is treated as unmatched (defense-in-depth)", async () => {
    _seedPredictionForTests(makePrediction({ joinable: false }));
    _seedOutcomeForTests(makeOutcome());
    const { rows, summary } = await joinTrainingDataset();
    expect(rows).toHaveLength(0);
    expect(summary.unmatched).toBe(1);
  });

  it("empty Cosmos → empty result with zero counts", async () => {
    const { rows, summary } = await joinTrainingDataset();
    expect(rows).toEqual([]);
    expect(summary.totalOutcomes).toBe(0);
    expect(summary.joined).toBe(0);
    expect(summary.unmatched).toBe(0);
  });
});

describe("trainingDatasetJoin — schema-doc sync", () => {
  it("FEATURE_KEYS exposes exactly the documented frozen set", () => {
    // This array is duplicated from docs/ML_TRAINING_SCHEMA.md FEATURES
    // tables on purpose: when this assertion fails, BOTH files must be
    // updated. The duplication is the lock.
    const DOCUMENTED_FEATURE_KEYS = [
      "playerName",
      "cardYear",
      "product",
      "parallel",
      "gradeCompany",
      "gradeValue",
      "fairMarketValue",
      "predictedPrice",
      "predictedPriceRangeLow",
      "predictedPriceRangeHigh",
      "forwardProjectionFactor",
      "trendIQ_composite",
      "trendIQ_playerMomentum",
      "trendIQ_cardTrajectory",
      "trendIQ_segmentTrajectory",
      "trendIQ_weight_playerMomentum",
      "trendIQ_weight_cardTrajectory",
      "trendIQ_weight_segmentTrajectory",
      "compsUsed",
      "cache_hit",
      "served_stale",
    ];
    expect([...FEATURE_KEYS].sort()).toEqual(DOCUMENTED_FEATURE_KEYS.sort());
  });
});
