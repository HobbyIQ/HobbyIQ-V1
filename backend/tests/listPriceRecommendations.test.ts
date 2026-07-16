import { describe, expect, it } from "vitest";
import { buildListPriceRecommendations } from "../src/services/compiq/listPriceRecommendations.service.js";

describe("buildListPriceRecommendations", () => {
  it("full data: uses predicted for suggested, range.high for aggressive, mv×0.9 for quickSale", () => {
    const r = buildListPriceRecommendations({
      marketValue: 200,
      predictedPrice: 220,
      predictedPriceRange: { low: 190, high: 260 },
    });
    expect(r).not.toBeNull();
    expect(r!.suggested).toBe(220);
    expect(r!.aggressive).toBe(260);
    expect(r!.quickSale).toBe(180);
    expect(r!.rationale.suggestedBasis).toBe("predicted next 30d");
  });

  it("no predicted: suggested falls back to marketValue, aggressive stays null-safe", () => {
    const r = buildListPriceRecommendations({
      marketValue: 100,
      predictedPrice: null,
      predictedPriceRange: null,
    });
    expect(r!.suggested).toBe(100);
    expect(r!.aggressive).toBeNull();
    expect(r!.quickSale).toBe(90);
    expect(r!.rationale.suggestedBasis).toBe("current market value");
  });

  it("no market value + no prediction → null (nothing to recommend)", () => {
    expect(buildListPriceRecommendations({
      marketValue: null, predictedPrice: null, predictedPriceRange: null,
    })).toBeNull();
  });

  it("predicted but no range: aggressive uses predicted × 1.10", () => {
    const r = buildListPriceRecommendations({
      marketValue: 100,
      predictedPrice: 120,
      predictedPriceRange: null,
    });
    expect(r!.aggressive).toBe(132);   // 120 × 1.10
  });

  it("negative / zero values treated as null (defensive)", () => {
    const r = buildListPriceRecommendations({
      marketValue: 0,
      predictedPrice: -5,
      predictedPriceRange: { high: -10, low: -20 },
    });
    expect(r).toBeNull();
  });
});
