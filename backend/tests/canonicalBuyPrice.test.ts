// CF-CANONICAL-BUY-PRICE (Drew, 2026-07-22). Pins the buyer-side
// discount math against the seller-side FMV. Pure function — no I/O.

import { describe, it, expect } from "vitest";
import {
  computeCanonicalBuyPrice,
  type CanonicalFmvResult,
} from "../src/services/compiq/canonicalFmv.service.js";

function fmvOk(fmv: number, method: CanonicalFmvResult["method"] = "direct-comp"): CanonicalFmvResult {
  return {
    fmv,
    method,
    confidence: 0.8,
    provenance: { summary: "test", comps: [], trendPctPerMonth: null, multipliers: {} },
    computedAt: "2026-07-22T00:00:00.000Z",
  };
}

function fmvNoBasis(): CanonicalFmvResult {
  return {
    fmv: null,
    method: "no-basis",
    confidence: 0,
    provenance: { summary: "no rung", comps: [], trendPctPerMonth: null, multipliers: {} },
    computedAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("computeCanonicalBuyPrice — happy path", () => {
  it("Hartman-shape FMV $4,401 → buy under ~$3,190 for flip context", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(4401.63));
    expect(buy.buyPrice).not.toBeNull();
    // Math: sellerNet = 4401.63 × 0.87 − 0.30 = 3829.12
    // buyPrice = 3829.12 / 1.20 = 3190.93
    expect(buy.buyPrice!).toBeCloseTo(3190.93, 1);
    expect(buy.context).toBe("flip");
    expect(buy.economics.targetMarginPct).toBe(0.20);
    expect(buy.economics.ebayFeePct).toBe(0.13);
    expect(buy.economics.sellerNetIfListedAtFmv).toBeCloseTo(3829.12, 1);
    expect(buy.summary).toContain("Sell $4401.63");
    expect(buy.summary).toContain("buy under $3190.93");
  });

  it("hold context uses 10% margin (higher buyPrice than flip)", () => {
    const flip = computeCanonicalBuyPrice(fmvOk(4401.63), { context: "flip" });
    const hold = computeCanonicalBuyPrice(fmvOk(4401.63), { context: "hold" });
    expect(hold.buyPrice!).toBeGreaterThan(flip.buyPrice!);
    // hold math: 3829.12 / 1.10 = 3481.02
    expect(hold.buyPrice!).toBeCloseTo(3481.02, 1);
    expect(hold.context).toBe("hold");
    expect(hold.economics.targetMarginPct).toBe(0.10);
  });

  it("carries FMV confidence to buyPrice (no additional uncertainty)", () => {
    const fmv = fmvOk(1000);
    fmv.confidence = 0.72;
    const buy = computeCanonicalBuyPrice(fmv);
    expect(buy.confidence).toBe(0.72);
  });

  it("echoes the FMV method for provenance tracking", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(500, "hot-raw-same-card-anchor"));
    expect(buy.economics.fmvMethod).toBe("hot-raw-same-card-anchor");
  });
});

describe("computeCanonicalBuyPrice — null passthrough", () => {
  it("no-basis FMV → buyPrice=null with zero confidence + explanatory summary", () => {
    const buy = computeCanonicalBuyPrice(fmvNoBasis());
    expect(buy.buyPrice).toBeNull();
    expect(buy.confidence).toBe(0);
    expect(buy.economics.fmvMethod).toBe("no-basis");
    expect(buy.summary).toContain("No FMV basis");
  });

  it("zero FMV → buyPrice=null", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(0));
    expect(buy.buyPrice).toBeNull();
  });

  it("negative FMV (defensive) → buyPrice=null", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(-100));
    expect(buy.buyPrice).toBeNull();
  });
});

describe("computeCanonicalBuyPrice — edge cases", () => {
  it("very-cheap FMV (fees dominate) → buyPrice is small but positive", () => {
    // FMV $2 → fees ~$0.56 → net ~$1.44 → buy ~$1.20 (flip)
    const buy = computeCanonicalBuyPrice(fmvOk(2));
    expect(buy.buyPrice).not.toBeNull();
    expect(buy.buyPrice!).toBeGreaterThan(0);
    expect(buy.buyPrice!).toBeLessThan(2);
  });

  it("expensive FMV maintains linear math (no capping)", () => {
    // FMV $50,000 → fees $6,500.30 → net $43,499.70 → buy $36,249.75 (flip)
    const buy = computeCanonicalBuyPrice(fmvOk(50000));
    expect(buy.buyPrice!).toBeCloseTo(36249.75, 1);
  });

  it("default context is 'flip' when opts omitted", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(1000));
    expect(buy.context).toBe("flip");
    expect(buy.economics.targetMarginPct).toBe(0.20);
  });
});

describe("computeCanonicalBuyPrice — economics transparency", () => {
  it("all fee constants are surfaced in economics for iOS transparency sheet", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(1000));
    expect(buy.economics.fmv).toBe(1000);
    expect(buy.economics.ebayFeePct).toBe(0.13);
    expect(buy.economics.ebayFeeFlat).toBe(0.30);
    expect(buy.economics.targetMarginPct).toBe(0.20);
    expect(buy.economics.sellerNetIfListedAtFmv).toBeCloseTo(869.70, 2);
    expect(buy.economics.fmvMethod).toBe("direct-comp");
  });

  it("summary explains the derivation in plain English", () => {
    const buy = computeCanonicalBuyPrice(fmvOk(1000));
    expect(buy.summary).toContain("Sell $1000.00");
    expect(buy.summary).toContain("eBay fees $130.30");
    expect(buy.summary).toContain("net $869.70");
    expect(buy.summary).toContain("20% flip margin");
    expect(buy.summary).toContain("buy under $724.75");
  });
});
