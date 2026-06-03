// CF-ADVANCED-ALERTS (2026-06-03): pure condition + rule evaluator coverage.

import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  evaluateRule,
  type EvaluationEstimateSlice,
} from "../src/services/advancedAlerts/conditionEvaluator.js";

const baseSlice: EvaluationEstimateSlice = {
  fairMarketValue: 100,
  predictedPrice: 110,
  pricingConfidence: 75,
  trendIQ: { composite: 1.18, direction: "up", coverage: "full" },
};

describe("evaluateCondition — predicted_direction", () => {
  it("fires when direction matches", () => {
    expect(
      evaluateCondition({ kind: "predicted_direction", equals: "up" }, baseSlice),
    ).toBe(true);
  });
  it("does not fire when direction differs", () => {
    expect(
      evaluateCondition({ kind: "predicted_direction", equals: "down" }, baseSlice),
    ).toBe(false);
  });
  it("does not fire when trendIQ is null", () => {
    expect(
      evaluateCondition(
        { kind: "predicted_direction", equals: "up" },
        { ...baseSlice, trendIQ: null },
      ),
    ).toBe(false);
  });
});

describe("evaluateCondition — predicted_pct_move", () => {
  it("gte: fires when move >= threshold (10% vs 5%)", () => {
    expect(
      evaluateCondition(
        { kind: "predicted_pct_move", op: "gte", value: 5 },
        baseSlice,
      ),
    ).toBe(true);
  });
  it("gte: does not fire when move < threshold", () => {
    expect(
      evaluateCondition(
        { kind: "predicted_pct_move", op: "gte", value: 15 },
        baseSlice,
      ),
    ).toBe(false);
  });
  it("lte: fires when move <= threshold (negative move)", () => {
    const downSlice = { ...baseSlice, predictedPrice: 90 };
    expect(
      evaluateCondition({ kind: "predicted_pct_move", op: "lte", value: -5 }, downSlice),
    ).toBe(true);
  });
  it("does not fire when fmv or pred missing", () => {
    expect(
      evaluateCondition(
        { kind: "predicted_pct_move", op: "gte", value: 5 },
        { ...baseSlice, fairMarketValue: null },
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { kind: "predicted_pct_move", op: "gte", value: 5 },
        { ...baseSlice, predictedPrice: null },
      ),
    ).toBe(false);
  });
});

describe("evaluateCondition — trendiq_composite", () => {
  it("gte fires when composite >= threshold", () => {
    expect(
      evaluateCondition(
        { kind: "trendiq_composite", op: "gte", value: 1.15 },
        baseSlice,
      ),
    ).toBe(true);
  });
  it("lte fires when composite <= threshold", () => {
    expect(
      evaluateCondition(
        { kind: "trendiq_composite", op: "lte", value: 1.20 },
        baseSlice,
      ),
    ).toBe(true);
  });
  it("does not fire when trendIQ is null", () => {
    expect(
      evaluateCondition(
        { kind: "trendiq_composite", op: "gte", value: 1.0 },
        { ...baseSlice, trendIQ: null },
      ),
    ).toBe(false);
  });
});

describe("evaluateCondition — trendiq_coverage_min", () => {
  it("fires when coverage >= threshold (full >= card_only)", () => {
    expect(
      evaluateCondition(
        { kind: "trendiq_coverage_min", value: "card_only" },
        baseSlice,
      ),
    ).toBe(true);
  });
  it("does not fire when coverage < threshold (player_only < full)", () => {
    expect(
      evaluateCondition(
        { kind: "trendiq_coverage_min", value: "full" },
        {
          ...baseSlice,
          trendIQ: { composite: 1.2, direction: "up", coverage: "player_only" },
        },
      ),
    ).toBe(false);
  });
});

describe("evaluateCondition — confidence_min", () => {
  it("fires when confidence >= threshold", () => {
    expect(
      evaluateCondition({ kind: "confidence_min", value: 70 }, baseSlice),
    ).toBe(true);
  });
  it("does not fire below threshold or when null", () => {
    expect(
      evaluateCondition({ kind: "confidence_min", value: 80 }, baseSlice),
    ).toBe(false);
    expect(
      evaluateCondition(
        { kind: "confidence_min", value: 50 },
        { ...baseSlice, pricingConfidence: null },
      ),
    ).toBe(false);
  });
});

describe("evaluateCondition — price_crosses", () => {
  const prev: EvaluationEstimateSlice = { ...baseSlice, fairMarketValue: 90 };
  const cur: EvaluationEstimateSlice = { ...baseSlice, fairMarketValue: 110 };
  it("fires on crossing above when before < threshold and after >= threshold", () => {
    expect(
      evaluateCondition({ kind: "price_crosses", op: "above", value: 100 }, cur, prev),
    ).toBe(true);
  });
  it("does not fire if already above on both passes", () => {
    expect(
      evaluateCondition(
        { kind: "price_crosses", op: "above", value: 100 },
        { ...baseSlice, fairMarketValue: 120 },
        { ...baseSlice, fairMarketValue: 105 },
      ),
    ).toBe(false);
  });
  it("crossing below: prev > threshold, cur <= threshold", () => {
    expect(
      evaluateCondition(
        { kind: "price_crosses", op: "below", value: 100 },
        { ...baseSlice, fairMarketValue: 95 },
        { ...baseSlice, fairMarketValue: 110 },
      ),
    ).toBe(true);
  });
  it("FALSE when no previous slice provided (first-evaluation)", () => {
    expect(
      evaluateCondition({ kind: "price_crosses", op: "above", value: 100 }, cur, null),
    ).toBe(false);
  });
});

describe("evaluateCondition — predicted_price_crosses", () => {
  it("fires when predicted price crosses above target", () => {
    const prev: EvaluationEstimateSlice = { ...baseSlice, predictedPrice: 90 };
    const cur: EvaluationEstimateSlice = { ...baseSlice, predictedPrice: 110 };
    expect(
      evaluateCondition(
        { kind: "predicted_price_crosses", op: "above", value: 100 },
        cur,
        prev,
      ),
    ).toBe(true);
  });
});

describe("evaluateRule — combinators", () => {
  const c1 = { kind: "predicted_direction", equals: "up" } as const;
  const c2 = { kind: "trendiq_composite", op: "gte", value: 1.15 } as const;
  const c3 = { kind: "confidence_min", value: 90 } as const;       // false @ baseSlice

  it("AND: all true -> fires", () => {
    expect(evaluateRule("AND", [c1, c2], baseSlice)).toBe(true);
  });
  it("AND: any false -> does not fire", () => {
    expect(evaluateRule("AND", [c1, c2, c3], baseSlice)).toBe(false);
  });
  it("OR: any true -> fires", () => {
    expect(evaluateRule("OR", [c1, c3], baseSlice)).toBe(true);
  });
  it("OR: all false -> does not fire", () => {
    expect(
      evaluateRule(
        "OR",
        [
          { kind: "predicted_direction", equals: "down" },
          { kind: "confidence_min", value: 90 },
        ],
        baseSlice,
      ),
    ).toBe(false);
  });
  it("empty conditions array -> does not fire", () => {
    expect(evaluateRule("AND", [], baseSlice)).toBe(false);
    expect(evaluateRule("OR", [], baseSlice)).toBe(false);
  });
});
