// D20 — the holding display-value ladder, pinned: observed before estimate,
// never cost-proxy, never a median, and an envelope that declined is final
// (no fall-through to legacy flats).
import { describe, expect, it } from "vitest";
import { fmvPerUnitOf, holdingDisplayValue, valuationStatusOf, type PortfolioHolding, type PricingEnvelope } from "./api";

function envelope(over: {
  value?: number | null;
  valueSource?: PricingEnvelope["headline"]["valueSource"];
  quantity?: number;
  observed?: number | null;
  estimate?: number | null;
}): PricingEnvelope {
  return {
    headline: {
      value: over.value ?? null,
      valueSource: over.valueSource ?? "unpriced",
      perUnit: over.value ?? null,
      quantity: over.quantity ?? 1,
    },
    observed: { fairMarketValue: over.observed ?? null, total: null },
    estimate: over.estimate != null
      ? { value: over.estimate, low: null, high: null, range: null, confidence: "estimate", basisNote: null }
      : null,
    method: { kind: "unknown", label: "—", ladderRung: null, compsUsed: null },
    confidence: { pricing: null, liquidity: null, timing: null },
    predicted: null,
    trend: { trendIQ: null, movementDirection: null, broaderTrendPctPerMonth: null, updatedAt: null },
    bands: null,
    provenance: {
      vendor: null, vendorUpdatedAt: null, pricingSource: null, pricingSourceMeta: null,
      nearestGradedAnchor: null, lastSaleSurface: null, modelExpectation: null, modelSignal: null,
    },
    quality: { score: null, flaggedCompCount: null, sources: [], freshness: "Live", lastPricedAt: null },
    composite: null,
    population: null,
  };
}

const base: PortfolioHolding = { id: "h1", quantity: 2, purchasePrice: 500, totalCostBasis: 1539, currentValue: 3078 };

describe("holdingDisplayValue", () => {
  it("observed headline × quantity", () => {
    const h = { ...base, pricing: envelope({ value: 100, valueSource: "observed", quantity: 2 }) };
    expect(holdingDisplayValue(h)).toBe(200);
  });

  it("estimated headline is shown (labelled elsewhere), not hidden", () => {
    const h = { ...base, pricing: envelope({ value: 80, valueSource: "estimated", quantity: 2 }) };
    expect(holdingDisplayValue(h)).toBe(160);
  });

  it("cost-proxy is never a value — the $1539 PSA 10 bug", () => {
    const h = { ...base, pricing: envelope({ value: 1539, valueSource: "cost-proxy", quantity: 1 }), fairMarketValue: 1531 };
    expect(holdingDisplayValue(h)).toBeNull();
  });

  it("an envelope that declined is final: no fall-through to legacy flats or currentValue", () => {
    const h = { ...base, pricing: envelope({ value: null, valueSource: "unpriced" }), fairMarketValue: 999, estimatedValue: 998 };
    expect(holdingDisplayValue(h)).toBeNull();
  });

  it("legacy flats only when there is no envelope: fmv, then estimate, never purchase price", () => {
    expect(holdingDisplayValue({ ...base, fairMarketValue: 10, estimatedValue: 9 })).toBe(20);
    expect(holdingDisplayValue({ ...base, fairMarketValue: null, estimatedValue: 9 })).toBe(18);
    expect(holdingDisplayValue({ ...base, fairMarketValue: null, estimatedValue: null })).toBeNull();
  });
});

describe("fmvPerUnitOf", () => {
  it("observed before estimate, envelope before flats", () => {
    expect(fmvPerUnitOf({ ...base, pricing: envelope({ observed: 100, estimate: 80 }), fairMarketValue: 5 })).toBe(100);
    expect(fmvPerUnitOf({ ...base, pricing: envelope({ observed: null, estimate: 80 }), fairMarketValue: 5 })).toBe(80);
    expect(fmvPerUnitOf({ ...base, fairMarketValue: 5, estimatedValue: 4 })).toBe(5);
    expect(fmvPerUnitOf({ ...base, estimatedValue: 4 })).toBe(4);
  });

  it("nothing priced -> null, never cost basis or currentValue", () => {
    expect(fmvPerUnitOf({ ...base, pricing: envelope({}) })).toBeNull();
    expect(fmvPerUnitOf(base)).toBeNull();
  });
});

describe("valuationStatusOf", () => {
  it("reads the envelope's headline, then the legacy flat", () => {
    expect(valuationStatusOf({ ...base, pricing: envelope({ valueSource: "observed" }) })).toBe("observed");
    expect(valuationStatusOf({ ...base, pricing: envelope({ valueSource: "estimated" }) })).toBe("estimated");
    expect(valuationStatusOf({ ...base, pricing: envelope({ valueSource: "cost-proxy" }), valuationStatus: "pending" })).toBe("pending");
    expect(valuationStatusOf(base)).toBeNull();
  });
});
