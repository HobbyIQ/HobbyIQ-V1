// D20 — the grade-curve tier pick (BuyerIQ's Market number), pinned:
// trendAdjustedValue, then value, NEVER the pool medians; no engine number
// -> null with the engine's reason, and the rung rides with the number.
import { describe, expect, it } from "vitest";
import { pickGradeCurveTierValue } from "./gradeCurveValue";

describe("pickGradeCurveTierValue", () => {
  it("prefers the trend-adjusted projection, then the tier's own value", () => {
    expect(pickGradeCurveTierValue({ trendAdjustedValue: 120, value: 100, weightedMedianPrice: 90 }).value).toBe(120);
    expect(pickGradeCurveTierValue({ trendAdjustedValue: null, value: 100, weightedMedianPrice: 90 }).value).toBe(100);
  });

  it("never falls through to a pool median — the BuyerIQ bug", () => {
    const picked = pickGradeCurveTierValue({
      trendAdjustedValue: null,
      value: null,
      valueSource: "unavailable",
      sampleCount: 3,
      weightedMedianPrice: 90,
      plainMedianPrice: 88,
    });
    expect(picked.value).toBeNull();
    expect(picked.rung.kind).toBe("unpriced");
    expect(picked.reason).toBe("no price at this grade (3 sales observed)");
    expect(picked.rung.text).toBe(picked.reason);
  });

  it("zero and negative numbers are not prices", () => {
    expect(pickGradeCurveTierValue({ trendAdjustedValue: 0, value: -5 }).value).toBeNull();
    expect(pickGradeCurveTierValue({ trendAdjustedValue: 0, value: 42 }).value).toBe(42);
  });

  it("no tier for the grade -> the route's reason when it gave one", () => {
    const withReason = pickGradeCurveTierValue(null, { curveReason: "catalog does not hold this slug" });
    expect(withReason.value).toBeNull();
    expect(withReason.reason).toBe("catalog does not hold this slug");
    expect(withReason.rung).toEqual({ kind: "unpriced", text: "catalog does not hold this slug", label: null });
    const without = pickGradeCurveTierValue(undefined);
    expect(without.reason).toBe("no tier for this grade");
  });

  it("an empty tier says there are no sales at this grade yet", () => {
    const picked = pickGradeCurveTierValue({ value: null, sampleCount: 0, rungLabel: null });
    expect(picked.reason).toBe("no sales at this grade yet");
  });

  it("the rung rides with the number, with the tier's own pool size", () => {
    const picked = pickGradeCurveTierValue({ trendAdjustedValue: 250, sampleCount: 6, rungLabel: "exact-pool-projection" });
    expect(picked.value).toBe(250);
    expect(picked.reason).toBeNull();
    expect(picked.rung.kind).toBe("observed");
    expect(picked.rung.text).toBe("projected from 6 sales of this card");
    const sibling = pickGradeCurveTierValue({ value: 30, sampleCount: 0, rungLabel: "grade-curve-estimate" });
    expect(sibling.rung.kind).toBe("estimate");
    expect(sibling.rung.text).toBe("estimate from the grade curve");
    const unlabeled = pickGradeCurveTierValue({ value: 30, sampleCount: 2 });
    expect(unlabeled.rung).toEqual({ kind: "unknown", text: "rung not reported", label: null });
  });
});
