// CF-DAILYIQ-ACTION-PLAN (Drew, 2026-07-17). Pinning tests for the
// per-holding verdict + urgency compute. Covers the priority lattice
// (SELL_NOW > GRADE_UP > LIST_HIGHER > WAIT_TO_LIST > HOLD) and the
// guestimate softening rule.

import { describe, it, expect } from "vitest";
import { computeActionPlan } from "../src/services/dailyiq/dailyIqActionPlanCompute.service.js";

describe("computeActionPlan — SELL_NOW gate", () => {
  it("Hartman scenario: velocity 2.3× + momentum 34% + fresh cascade", () => {
    const r = computeActionPlan({
      marketValue: 1990,
      predictedPrice: 2639,
      sellRadar: {
        velocityMultiple: 2.3,
        playerMomentum: 1.34,
        playerDirection: "up",
        cardDirection: "up",
      },
      cascade: { firedAt: "", daysSinceFire: 3, audienceTier: "engaged_fan" },
    });
    expect(r.verdict).toBe("SELL_NOW");
    expect(r.urgency).toBeGreaterThan(70);
    expect(r.urgency).toBeLessThanOrEqual(100);
    expect(r.priceTarget).toBe(2639);
    expect(r.reason).toContain("2.3×");
    expect(r.reason).toContain("cascade fired");
    expect(r.windowClosesIn).toContain("days");
  });

  it("No cascade → no cascade boost but SELL_NOW still fires", () => {
    const r = computeActionPlan({
      marketValue: 1000, predictedPrice: 1300,
      sellRadar: {
        velocityMultiple: 2.5, playerMomentum: 1.20,
        playerDirection: "up", cardDirection: "up",
      },
    });
    expect(r.verdict).toBe("SELL_NOW");
    expect(r.reason).not.toContain("cascade");
    expect(r.windowClosesIn).toBeNull();
  });

  it("Player downtrend blocks SELL_NOW even with velocity", () => {
    const r = computeActionPlan({
      marketValue: 1000, predictedPrice: 1000,
      sellRadar: {
        velocityMultiple: 3.0, playerMomentum: 0.95,
        playerDirection: "down", cardDirection: "up",
      },
    });
    expect(r.verdict).not.toBe("SELL_NOW");
  });

  it("Card downtrend blocks SELL_NOW", () => {
    const r = computeActionPlan({
      marketValue: 1000, predictedPrice: 900,
      sellRadar: {
        velocityMultiple: 2.5, playerMomentum: 1.15,
        playerDirection: "up", cardDirection: "down",
      },
    });
    expect(r.verdict).not.toBe("SELL_NOW");
  });

  it("Guestimate softens: SELL_NOW does not fire on guestimated FMV", () => {
    const r = computeActionPlan({
      marketValue: 1000, predictedPrice: 1500, isGuestimate: true,
      sellRadar: {
        velocityMultiple: 3.0, playerMomentum: 1.30,
        playerDirection: "up", cardDirection: "up",
      },
    });
    expect(r.verdict).not.toBe("SELL_NOW");
    expect(r.verdict).toBe("HOLD");
    expect(r.reason).toContain("family multipliers");
  });
});

describe("computeActionPlan — GRADE_UP gate", () => {
  it("50% expected uplift + high confidence → GRADE_UP", () => {
    const r = computeActionPlan({
      marketValue: 200, predictedPrice: 220,
      gradeWorthy: {
        bestTier: "PSA 10",
        expectedNetUplift: 800,      // net after $80 grading
        expectedUpliftPct: 4.0,      // 4× lift on a $200 raw
        confidence: "high",
      },
    });
    expect(r.verdict).toBe("GRADE_UP");
    expect(r.urgency).toBeGreaterThanOrEqual(40);
    expect(r.urgency).toBeLessThanOrEqual(69);
    expect(r.reason).toContain("PSA 10");
    expect(r.reason).toContain("+$800");
    expect(r.priceTarget).toBeCloseTo(1000, 0);   // 200 + 800
  });

  it("Low uplift (below 30%) skips GRADE_UP", () => {
    const r = computeActionPlan({
      marketValue: 100, predictedPrice: 100,
      gradeWorthy: {
        bestTier: "PSA 10",
        expectedNetUplift: 20,
        expectedUpliftPct: 0.20,
        confidence: "high",
      },
    });
    expect(r.verdict).not.toBe("GRADE_UP");
  });

  it("Low confidence skips GRADE_UP even with big uplift", () => {
    const r = computeActionPlan({
      marketValue: 100, predictedPrice: 100,
      gradeWorthy: {
        bestTier: "PSA 10",
        expectedNetUplift: 400,
        expectedUpliftPct: 4.0,
        confidence: "low",
      },
    });
    expect(r.verdict).not.toBe("GRADE_UP");
  });
});

describe("computeActionPlan — LIST_HIGHER gate", () => {
  it("Predicted 25% above current asking → LIST_HIGHER", () => {
    const r = computeActionPlan({
      marketValue: 800,
      predictedPrice: 1000,
      currentAskingPrice: 800,
    });
    expect(r.verdict).toBe("LIST_HIGHER");
    expect(r.urgency).toBeGreaterThanOrEqual(25);
    expect(r.urgency).toBeLessThanOrEqual(60);
    expect(r.reason).toContain("Predicted $1000");
    expect(r.reason).toContain("+25%");
    expect(r.priceTarget).toBe(1000);
  });

  it("Predicted only 5% above → skips LIST_HIGHER (under 15% threshold)", () => {
    const r = computeActionPlan({
      marketValue: 800,
      predictedPrice: 840,
      currentAskingPrice: 800,
    });
    expect(r.verdict).not.toBe("LIST_HIGHER");
  });

  it("No asking price → gap measured against FMV", () => {
    const r = computeActionPlan({
      marketValue: 800,
      predictedPrice: 1000,
      // no currentAskingPrice
    });
    expect(r.verdict).toBe("LIST_HIGHER");
    expect(r.reason).toContain("FMV");
  });
});

describe("computeActionPlan — WAIT_TO_LIST", () => {
  it("Momentum +10%/wk, no velocity — WAIT_TO_LIST fires", () => {
    const r = computeActionPlan({
      marketValue: 500, predictedPrice: 510,
      matchedCohortWeeklyRate: 0.10,
    });
    expect(r.verdict).toBe("WAIT_TO_LIST");
    expect(r.reason).toContain("10%/wk");
    expect(r.urgency).toBeGreaterThanOrEqual(10);
    expect(r.urgency).toBeLessThanOrEqual(30);
  });

  it("Below +5%/wk → HOLD", () => {
    const r = computeActionPlan({
      marketValue: 500, predictedPrice: 500,
      matchedCohortWeeklyRate: 0.02,
    });
    expect(r.verdict).toBe("HOLD");
  });
});

describe("computeActionPlan — HOLD (default)", () => {
  it("No signals at all → HOLD", () => {
    const r = computeActionPlan({
      marketValue: 500, predictedPrice: 500,
    });
    expect(r.verdict).toBe("HOLD");
    expect(r.urgency).toBe(0);
    expect(r.priceTarget).toBeNull();
  });

  it("Guestimate + no signals → HOLD with 'no comps yet' reason", () => {
    const r = computeActionPlan({
      marketValue: 500, predictedPrice: 500, isGuestimate: true,
    });
    expect(r.verdict).toBe("HOLD");
    expect(r.reason).toContain("No comps");
  });
});

describe("Urgency ordering invariant", () => {
  it("SELL_NOW min urgency > GRADE_UP max", () => {
    const sellNow = computeActionPlan({
      marketValue: 1000, predictedPrice: 1000,
      sellRadar: {
        velocityMultiple: 2.0, playerMomentum: 1.10,
        playerDirection: "up", cardDirection: "up",
      },
    });
    const gradeUp = computeActionPlan({
      marketValue: 200, predictedPrice: 200,
      gradeWorthy: {
        bestTier: "PSA 10", expectedNetUplift: 800,
        expectedUpliftPct: 4.0, confidence: "high",
      },
    });
    // sortable-by-urgency invariant: SELL_NOW always ranks above GRADE_UP
    expect(sellNow.urgency).toBeGreaterThan(gradeUp.urgency);
  });

  it("HOLD urgency is 0", () => {
    const r = computeActionPlan({ marketValue: 100, predictedPrice: 100 });
    expect(r.urgency).toBe(0);
  });
});
