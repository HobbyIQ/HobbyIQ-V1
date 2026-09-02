// CF-BUYERIQ-DEAL-GATE (Drew, 2026-09-02). Pins the deal scanner's
// arithmetic and its refusals.
//
// The pins Drew named, in his words:
//   - threshold arithmetic
//   - "a 0.2-confidence projection at 25% under does NOT flag;
//      a 0.8 at 25% does"
//   - never flag off a no-basis or speculative-confidence projection
//   - quota-budgeted scan, with a refusal when the budget is exhausted

import { describe, expect, it } from "vitest";
import {
  evaluateDeal,
  discountPct,
  requiredDiscountPct,
  isNoBasis,
  DEFAULT_BASE_DISCOUNT_PCT,
  FULL_CONFIDENCE,
  MAX_REQUIRED_DISCOUNT_PCT,
  MIN_FLAGGABLE_CONFIDENCE,
} from "../src/services/buyeriq/dealGate.js";
import {
  ScanBudget,
  DEFAULT_VENDOR_CALL_BUDGET,
  MAX_VENDOR_CALL_BUDGET,
} from "../src/services/buyeriq/scanBudget.js";
import { SPECULATIVE_CONFIDENCE } from "../src/services/compiq/playerIndex.service.js";

describe("discountPct — the threshold arithmetic", () => {
  it("measures the discount as a fraction OF THE PROJECTION", () => {
    // $75 ask against a $100 projection is 25% under.
    expect(discountPct(75, 100)).toBeCloseTo(0.25, 10);
    expect(discountPct(80, 100)).toBeCloseTo(0.20, 10);
    expect(discountPct(50, 200)).toBeCloseTo(0.75, 10);
  });

  it("is negative when the ask is ABOVE the projection", () => {
    expect(discountPct(120, 100)).toBeCloseTo(-0.20, 10);
  });

  it("is zero at parity", () => {
    expect(discountPct(100, 100)).toBe(0);
  });

  it("refuses to manufacture a discount from a degenerate projection", () => {
    // A zero/negative/NaN projection must never read as "100% off".
    expect(discountPct(50, 0)).toBe(0);
    expect(discountPct(50, -10)).toBe(0);
    expect(discountPct(50, Number.NaN)).toBe(0);
    expect(discountPct(0, 100)).toBe(0);
    expect(discountPct(Number.NaN, 100)).toBe(0);
  });
});

describe("requiredDiscountPct — confidence weighting", () => {
  it("applies the base threshold unchanged at full confidence", () => {
    expect(requiredDiscountPct(FULL_CONFIDENCE, 0.20)).toBeCloseTo(0.20, 6);
    expect(requiredDiscountPct(1.0, 0.20)).toBeCloseTo(0.20, 6);
  });

  it("demands a DEEPER discount as confidence falls — thin pools cost more", () => {
    const at90 = requiredDiscountPct(0.90, 0.20);
    const at80 = requiredDiscountPct(0.80, 0.20);
    const at60 = requiredDiscountPct(0.60, 0.20);
    const at40 = requiredDiscountPct(0.40, 0.20);
    expect(at80).toBeGreaterThan(at90);
    expect(at60).toBeGreaterThan(at80);
    expect(at40).toBeGreaterThan(at60);
  });

  it("computes base x (0.9 / confidence)", () => {
    // 0.20 × (0.9 / 0.8) = 0.225
    expect(requiredDiscountPct(0.80, 0.20)).toBeCloseTo(0.225, 6);
    // 0.20 × (0.9 / 0.6) = 0.30
    expect(requiredDiscountPct(0.60, 0.20)).toBeCloseTo(0.30, 6);
    // 0.20 × (0.9 / 0.4) = 0.45
    expect(requiredDiscountPct(0.40, 0.20)).toBeCloseTo(0.45, 6);
  });

  it("caps the requirement so it never demands an implausible discount", () => {
    expect(requiredDiscountPct(0.05, 0.20)).toBe(MAX_REQUIRED_DISCOUNT_PCT);
    expect(requiredDiscountPct(0, 0.20)).toBe(MAX_REQUIRED_DISCOUNT_PCT);
    expect(requiredDiscountPct(Number.NaN, 0.20)).toBe(MAX_REQUIRED_DISCOUNT_PCT);
  });

  it("honours a caller-configured base threshold", () => {
    expect(requiredDiscountPct(FULL_CONFIDENCE, 0.30)).toBeCloseTo(0.30, 6);
    expect(requiredDiscountPct(FULL_CONFIDENCE, 0.10)).toBeCloseTo(0.10, 6);
  });

  it("defaults to 20% under when the base is missing or nonsense", () => {
    expect(requiredDiscountPct(FULL_CONFIDENCE)).toBeCloseTo(DEFAULT_BASE_DISCOUNT_PCT, 6);
    expect(requiredDiscountPct(FULL_CONFIDENCE, 0)).toBeCloseTo(DEFAULT_BASE_DISCOUNT_PCT, 6);
    expect(requiredDiscountPct(FULL_CONFIDENCE, Number.NaN)).toBeCloseTo(DEFAULT_BASE_DISCOUNT_PCT, 6);
  });
});

describe("PINNED: confidence gating at 25% under", () => {
  // Drew's exact pin. Same card, same ask, same discount — only the
  // confidence in the projection differs, and that decides it.
  const listingPrice = 75;   // 25% under a $100 projection
  const fmv = 100;

  it("a 0.2-confidence projection at 25% under does NOT flag", () => {
    const verdict = evaluateDeal({
      listingPrice, fmv,
      confidence: 0.2,
      method: "player-index-projection",
      rungLabel: "player-index-projection",
    });
    expect(verdict.flagged).toBe(false);
    expect(verdict.refusal).toBe("speculative-confidence");
    // The basis is still returned so the feed can explain the near-miss.
    expect(verdict.basis?.discountPct).toBeCloseTo(0.25, 10);
  });

  it("a 0.8-confidence projection at 25% under DOES flag", () => {
    const verdict = evaluateDeal({
      listingPrice, fmv,
      confidence: 0.8,
      method: "direct-comp",
      rungLabel: "exact-pool-projection",
    });
    expect(verdict.flagged).toBe(true);
    expect(verdict.refusal).toBeNull();
    expect(verdict.basis?.discountPct).toBeCloseTo(0.25, 10);
    // 0.8 confidence requires 22.5%; 25% clears it.
    expect(verdict.basis?.requiredDiscountPct).toBeCloseTo(0.225, 6);
    expect(verdict.basis?.exactPool).toBe(true);
  });

  it("the speculative refusal holds at ANY discount, however deep", () => {
    // A 90%-under listing on a speculative projection is evidence the
    // projection is wrong, not evidence of a deal.
    for (const price of [50, 25, 10, 1]) {
      const verdict = evaluateDeal({
        listingPrice: price, fmv,
        confidence: SPECULATIVE_CONFIDENCE,
        method: "player-index-projection",
        rungLabel: "player-index-projection",
      });
      expect(verdict.flagged).toBe(false);
      expect(verdict.refusal).toBe("speculative-confidence");
    }
  });

  it("ties the speculative floor to the engine's own constant", () => {
    // If the engine moves SPECULATIVE_CONFIDENCE, the gate moves with it.
    expect(MIN_FLAGGABLE_CONFIDENCE).toBe(SPECULATIVE_CONFIDENCE);
  });

  it("flags just above the floor only when the deep discount is met", () => {
    const justAbove = SPECULATIVE_CONFIDENCE + 0.01;   // 0.21
    // required = min(0.60, 0.20 × 0.9/0.21) = 0.60 (at the cap)
    expect(requiredDiscountPct(justAbove, 0.20)).toBe(MAX_REQUIRED_DISCOUNT_PCT);
    // 25% under does not clear a 60% requirement.
    expect(evaluateDeal({
      listingPrice: 75, fmv, confidence: justAbove, method: "cross-parallel", rungLabel: "cross-parallel",
    }).flagged).toBe(false);
    // 65% under does.
    expect(evaluateDeal({
      listingPrice: 35, fmv, confidence: justAbove, method: "cross-parallel", rungLabel: "cross-parallel",
    }).flagged).toBe(true);
  });
});

describe("PINNED: never flag off a no-basis projection", () => {
  it("refuses when the method is no-basis", () => {
    const verdict = evaluateDeal({
      listingPrice: 10, fmv: 100, confidence: 0.95, method: "no-basis", rungLabel: "no-basis",
    });
    expect(verdict.flagged).toBe(false);
    expect(verdict.refusal).toBe("no-basis");
    expect(verdict.basis).toBeNull();
  });

  it("refuses when there is no projection at all", () => {
    for (const fmv of [null, 0, -5, Number.NaN]) {
      const verdict = evaluateDeal({
        listingPrice: 10, fmv: fmv as number | null, confidence: 0.95, method: "direct-comp",
      });
      expect(verdict.flagged).toBe(false);
      expect(verdict.refusal).toBe("no-basis");
    }
  });

  it("no-basis outranks confidence — a confident nothing is still nothing", () => {
    // High confidence must not rescue a missing projection.
    const verdict = evaluateDeal({
      listingPrice: 1, fmv: null, confidence: 1.0, method: "no-basis",
    });
    expect(verdict.refusal).toBe("no-basis");
  });

  it("isNoBasis names the cases directly", () => {
    expect(isNoBasis(null, "direct-comp")).toBe(true);
    expect(isNoBasis(undefined, "direct-comp")).toBe(true);
    expect(isNoBasis(0, "direct-comp")).toBe(true);
    expect(isNoBasis(100, "no-basis")).toBe(true);
    expect(isNoBasis(100, "direct-comp")).toBe(false);
  });

  it("refuses a listing with no usable price", () => {
    const verdict = evaluateDeal({
      listingPrice: 0, fmv: 100, confidence: 0.95, method: "direct-comp",
    });
    expect(verdict.flagged).toBe(false);
    expect(verdict.refusal).toBe("no-listing-price");
  });
});

describe("threshold boundary", () => {
  it("flags exactly AT the required discount, not just above it", () => {
    // At full confidence the requirement is the base: 20% under.
    const verdict = evaluateDeal({
      listingPrice: 80, fmv: 100, confidence: 0.95, method: "direct-comp", rungLabel: "exact-pool-projection",
    });
    expect(verdict.flagged).toBe(true);
    expect(verdict.basis?.discountPct).toBeCloseTo(0.20, 10);
  });

  it("does not flag a hair under the requirement", () => {
    const verdict = evaluateDeal({
      listingPrice: 80.01, fmv: 100, confidence: 0.95, method: "direct-comp",
    });
    expect(verdict.flagged).toBe(false);
    expect(verdict.refusal).toBe("below-threshold");
  });

  it("does not flag a listing priced ABOVE the projection", () => {
    const verdict = evaluateDeal({
      listingPrice: 130, fmv: 100, confidence: 0.95, method: "direct-comp",
    });
    expect(verdict.flagged).toBe(false);
    expect(verdict.refusal).toBe("below-threshold");
    expect(verdict.basis?.discountPct).toBeLessThan(0);
  });

  it("carries the rung and exact-pool judgement onto the basis", () => {
    const exact = evaluateDeal({
      listingPrice: 70, fmv: 100, confidence: 0.9, method: "direct-comp", rungLabel: "exact-pool-last-sale",
    });
    expect(exact.basis?.rung).toBe("exact-pool-last-sale");
    expect(exact.basis?.exactPool).toBe(true);

    const fallback = evaluateDeal({
      listingPrice: 70, fmv: 100, confidence: 0.9, method: "cross-parallel", rungLabel: "cross-parallel",
    });
    expect(fallback.basis?.rung).toBe("cross-parallel");
    expect(fallback.basis?.exactPool).toBe(false);
    // A fallback rung still flags — it is a real basis, just not the
    // exact pool. Confidence is what gates it, not the rung name.
    expect(fallback.flagged).toBe(true);
  });
});

describe("PINNED: quota-budgeted scan", () => {
  it("spends down to the limit and then refuses", () => {
    const budget = new ScanBudget(3);
    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(true);
    expect(budget.spend()).toBe(true);
    // Fourth call is refused — the pinned refusal.
    expect(budget.spend()).toBe(false);
    expect(budget.isExhausted()).toBe(true);
    expect(budget.state().spent).toBe(3);
    expect(budget.state().remaining).toBe(0);
  });

  it("does not charge for a refused spend", () => {
    const budget = new ScanBudget(1);
    budget.spend();
    budget.spend();
    budget.spend();
    // Still exactly the limit — refusals never over-count.
    expect(budget.state().spent).toBe(1);
  });

  it("serves cache hits FREE — they never draw down the vendor budget", () => {
    const budget = new ScanBudget(2);
    for (let i = 0; i < 50; i++) budget.recordCacheHit();
    expect(budget.state().spent).toBe(0);
    expect(budget.state().remaining).toBe(2);
    expect(budget.state().cacheHits).toBe(50);
    expect(budget.canSpend()).toBe(true);
  });

  it("is not exhausted until a spend is actually refused", () => {
    const budget = new ScanBudget(1);
    expect(budget.isExhausted()).toBe(false);
    budget.spend();
    // Limit reached, but nothing has been refused yet.
    expect(budget.canSpend()).toBe(false);
    expect(budget.isExhausted()).toBe(false);
    budget.spend();
    expect(budget.isExhausted()).toBe(true);
  });

  it("a zero budget refuses immediately — it never makes one free call", () => {
    const budget = new ScanBudget(0);
    expect(budget.canSpend()).toBe(false);
    expect(budget.spend()).toBe(false);
    expect(budget.state().spent).toBe(0);
  });

  it("clamps a misconfigured budget so one scan cannot take the whole tier", () => {
    expect(new ScanBudget(999999).state().limit).toBe(MAX_VENDOR_CALL_BUDGET);
    expect(new ScanBudget(-5).state().limit).toBe(0);
  });

  it("defaults to a slice of the daily tier, not the whole thing", () => {
    // eBay Browse free tier is 5000/day and the scanner is not its only
    // consumer (daily snapshot job, Card Detail, listing-range).
    expect(DEFAULT_VENDOR_CALL_BUDGET).toBeLessThan(5000);
    expect(DEFAULT_VENDOR_CALL_BUDGET).toBeGreaterThan(0);
  });
});
