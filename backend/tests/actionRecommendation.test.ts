// CF-ACTION-RECOMMENDATION (2026-07-05) — pins the sell/hold/list
// verdict logic. This is the product surface that renders as a badge
// on iOS inventory rows and per-grade pills.

import { describe, it, expect } from "vitest";
import { computeAction } from "../src/services/compiq/actionRecommendation.service.js";

describe("CF-ACTION-RECOMMENDATION — computeAction", () => {
  describe("INSUFFICIENT_DATA guard", () => {
    it("returns INSUFFICIENT_DATA when currentValue is null", () => {
      const r = computeAction({
        currentValue: null,
        predictedValue: 200,
        confidenceScore: 0.85,
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("INSUFFICIENT_DATA");
      expect(r.targetPrice).toBeNull();
      expect(r.urgency).toBeNull();
    });

    it("returns INSUFFICIENT_DATA when predictedValue is null", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: null,
        confidenceScore: 0.85,
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("INSUFFICIENT_DATA");
    });

    it("returns INSUFFICIENT_DATA when confidence is below the floor (< 0.20)", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 300,     // huge gap that would normally fire HOLD
        confidenceScore: 0.15,   // but confidence too thin
        signalSource: "parallel-tier",
      });
      expect(r.verdict).toBe("INSUFFICIENT_DATA");
    });
  });

  describe("HOLD (rising with confidence)", () => {
    it("returns HOLD when Predicted is >15% above current AND confidence ≥ 0.60", () => {
      const r = computeAction({
        currentValue: 100,
        predictedValue: 130,   // +30% projected
        confidenceScore: 0.85,
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("HOLD");
      expect(r.urgency).toBe("low");
      expect(r.expectedDeltaPct).toBe(30);
      expect(r.reasoning).toContain("up");
    });

    it("does NOT return HOLD when confidence is below 0.60 (moderate gap → LIST fallback)", () => {
      const r = computeAction({
        currentValue: 100,
        predictedValue: 130,
        confidenceScore: 0.45,   // ballpark tier
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("LIST");
    });
  });

  describe("SELL_NOW (falling with confidence)", () => {
    it("returns SELL_NOW when Predicted is >15% below current AND confidence ≥ 0.40", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 150,   // -25% projected
        confidenceScore: 0.60,
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("SELL_NOW");
      expect(r.urgency).toBe("high");
      expect(r.expectedDeltaPct).toBe(-25);
    });

    it("mentions cost basis in reasoning when Predicted is below cost basis", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 100,
        confidenceScore: 0.60,
        signalSource: "release-decay-blend",
        costBasis: 175,   // predicted $100 < $175 cost
      });
      expect(r.verdict).toBe("SELL_NOW");
      expect(r.reasoning).toContain("175");
      expect(r.reasoning).toContain("cost");
    });
  });

  describe("LIST early-decay override", () => {
    it("recommends LIST at undercut when in first 4 weeks post-release on decay signal", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 195,   // small gap that would normally be fair-value LIST
        confidenceScore: 0.85,
        signalSource: "release-decay-blend",
        weeksSinceRelease: 2,
      });
      expect(r.verdict).toBe("LIST");
      expect(r.urgency).toBe("high");
      expect(r.targetPrice).toBe(190);   // 200 × 0.95
      expect(r.reasoning).toContain("supply");
    });

    it("does NOT trigger early-decay override past 4 weeks post-release", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 195,
        confidenceScore: 0.85,
        signalSource: "release-decay-blend",
        weeksSinceRelease: 5,
      });
      // Falls through to fair-value LIST
      expect(r.verdict).toBe("LIST");
      expect(r.urgency).toBe("medium");
      expect(r.targetPrice).toBeGreaterThan(200);
    });

    it("does NOT trigger early-decay override on non-decay signals", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 195,
        confidenceScore: 0.85,
        signalSource: "matched-cohort-cached",
        weeksSinceRelease: 2,   // week matters but signal doesn't
      });
      expect(r.verdict).toBe("LIST");
      expect(r.urgency).toBe("medium");
    });
  });

  describe("LIST fair-value fallback", () => {
    it("returns LIST at max(predicted × 1.02, current × 1.03) for flat/moderate signals", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 210,     // +5% projected — moderate rise
        confidenceScore: 0.85,
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("LIST");
      expect(r.urgency).toBe("medium");
      expect(r.targetPrice).toBeGreaterThan(200);
    });

    it("never lists BELOW current value even when Predicted is below", () => {
      const r = computeAction({
        currentValue: 200,
        predictedValue: 190,     // small decline, not enough for SELL_NOW
        confidenceScore: 0.85,
        signalSource: "matched-cohort-cached",
      });
      expect(r.verdict).toBe("LIST");
      // max(190 × 1.02, 200 × 1.03) = max(193.80, 206) = 206
      expect(r.targetPrice).toBe(206);
    });
  });
});
