// CF-GEM-RATE-WIRED (PR #495 follow-up) — pins the getGraderPremium ↔
// gemRateSignal wiring: top-grade multipliers on cards with ≥10 observed
// base graded sales come from the -3·ln(gemRate) + 0.5 formula instead of
// the static table. Mid-tier grades keep the table. Absent / low-confidence
// signal is a no-op.

import { describe, expect, it, vi } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";
import {
  computeGemRateFromObservations,
  multiplierFromGemRate,
} from "../src/services/compiq/gemRateSignal.service.js";
import { buildGemRateSignalFromPricing } from "../src/services/compiq/gradedPriceProjection.js";
import type { CardsightPricingResponse, CardsightSaleRecord } from "../src/services/compiq/catalogSource.js";

function mkRec(title: string, price: number, parallelId: string | null = null): CardsightSaleRecord {
  return {
    price,
    title,
    parallel_id: parallelId,
    sold_date: "2026-06-01",
  } as CardsightSaleRecord;
}

function mkPricing(observations: Array<{ company: string; grade: string; price: number }>): CardsightPricingResponse {
  const byCompany = new Map<string, Map<string, CardsightSaleRecord[]>>();
  for (const o of observations) {
    if (!byCompany.has(o.company)) byCompany.set(o.company, new Map());
    const grades = byCompany.get(o.company)!;
    if (!grades.has(o.grade)) grades.set(o.grade, []);
    grades.get(o.grade)!.push(mkRec(`${o.company} ${o.grade} test card`, o.price));
  }
  return {
    card: { card_id: "test-card", name: "Test Card", number: "1" } as any,
    raw: { count: 0, records: [] },
    graded: Array.from(byCompany.entries()).map(([company, grades]) => ({
      company_name: company,
      grades: Array.from(grades.entries()).map(([grade, records]) => ({
        grade_value: grade,
        records,
      })),
    })) as any,
    meta: { total_records: 0, last_sale_date: null },
  } as CardsightPricingResponse;
}

describe("getGraderPremium — gem-rate signal override", () => {
  it("high-confidence signal with 10% gem rate → PSA 10 uses formula (~7.41), not table 3.5", () => {
    const sig = computeGemRateFromObservations([
      // 4 PSA 10 out of 40 total → gem rate 0.10
      ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    expect(sig!.confidence).toBe("high");
    const formula = multiplierFromGemRate(sig!.gemRate);
    expect(formula).toBeGreaterThan(5);
    expect(formula).toBeLessThan(9);
    const withSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
    // Without signal, PSA 10 at $50 base ~ 2.8-3.5×. With 10% gem rate signal, formula (~7.4×) wins.
    expect(withSignal).toBeCloseTo(formula, 2);
    const withoutSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null);
    expect(withoutSignal).toBeLessThan(withSignal);
  });

  it("mid-tier grade (PSA 9) does NOT use gem-rate formula, falls through to table", () => {
    const sig = computeGemRateFromObservations([
      ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    const withSignal = getGraderPremium("PSA", "9", 50, "base", 2024, null, sig);
    const withoutSignal = getGraderPremium("PSA", "9", 50, "base", 2024, null);
    // PSA 9 is not a top grade — table wins regardless.
    expect(withSignal).toBe(withoutSignal);
  });

  it("low-confidence signal (<10 obs) → falls back to table", () => {
    const sig = computeGemRateFromObservations([
      { grade: "PSA 10", price: 200 },
      { grade: "PSA 9", price: 100 },
    ]);
    expect(sig!.confidence).toBe("low");
    const withSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
    const withoutSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null);
    expect(withSignal).toBe(withoutSignal);
  });

  it("null signal → identical to no-signal call", () => {
    const withSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null, null);
    const withoutSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null);
    expect(withSignal).toBe(withoutSignal);
  });

  it("BGS 10 Black Label is a top grade → formula applies", () => {
    const sig = computeGemRateFromObservations([
      ...Array.from({ length: 5 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 35 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    const withSignal = getGraderPremium("BGS", "10 Black Label", 50, "base", 2024, null, sig);
    const withoutSignal = getGraderPremium("BGS", "10 Black Label", 50, "base", 2024, null);
    expect(withSignal).not.toBe(withoutSignal);
    // Formula for gem rate ~12.5% → -3·ln(0.125)+0.5 = 6.74
    expect(withSignal).toBeGreaterThan(4);
    expect(withSignal).toBeLessThan(10);
  });

  it("condition-sensitive-set bump still stacks on top of the formula", () => {
    const sig = computeGemRateFromObservations([
      ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    const plainSet = getGraderPremium("PSA", "10", 50, "base", 2024, "2024 Topps Chrome", sig);
    // 1993 SP is one of the condition-sensitive sets (per compiqEstimate.service.ts)
    const conditionSet = getGraderPremium("PSA", "10", 50, "base", 1993, "1993 SP", sig);
    // Vintage era override may intercept for 1993 (edge of vintage); use a modern set year with real bump.
    // Chrome-chipping era 2003-2006 Topps Chrome carries a bump.
    const chromeSet = getGraderPremium("PSA", "10", 50, "base", 2005, "2005 Topps Chrome", sig);
    // At minimum, the plain set uses the formula unbumped.
    expect(plainSet).toBeCloseTo(multiplierFromGemRate(sig!.gemRate), 2);
    // If chromeSet has a bump, it multiplies. Assert monotonic — bumped >= unbumped.
    expect(chromeSet).toBeGreaterThanOrEqual(plainSet);
  });
});

describe("GEM_RATE_MULTIPLIER_ENABLED killswitch", () => {
  it("env=\"false\" disables the override, falls back to table", () => {
    const prev = process.env.GEM_RATE_MULTIPLIER_ENABLED;
    process.env.GEM_RATE_MULTIPLIER_ENABLED = "false";
    try {
      const sig = computeGemRateFromObservations([
        ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
        ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
      ]);
      const withSignalDisabled = getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
      const noSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null);
      expect(withSignalDisabled).toBe(noSignal);
    } finally {
      if (prev === undefined) delete process.env.GEM_RATE_MULTIPLIER_ENABLED;
      else process.env.GEM_RATE_MULTIPLIER_ENABLED = prev;
    }
  });

  it("env unset → override is ON (default)", () => {
    const prev = process.env.GEM_RATE_MULTIPLIER_ENABLED;
    delete process.env.GEM_RATE_MULTIPLIER_ENABLED;
    try {
      const sig = computeGemRateFromObservations([
        ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
        ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
      ]);
      const withSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
      const noSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null);
      expect(withSignal).not.toBe(noSignal);
      expect(withSignal).toBeGreaterThan(noSignal);
    } finally {
      if (prev === undefined) delete process.env.GEM_RATE_MULTIPLIER_ENABLED;
      else process.env.GEM_RATE_MULTIPLIER_ENABLED = prev;
    }
  });

  it.each(["0", "off", "no", "FALSE"])("env=%s also disables (all falsy variants)", (v) => {
    const prev = process.env.GEM_RATE_MULTIPLIER_ENABLED;
    process.env.GEM_RATE_MULTIPLIER_ENABLED = v;
    try {
      const sig = computeGemRateFromObservations([
        ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
        ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
      ]);
      const withSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
      const noSignal = getGraderPremium("PSA", "10", 50, "base", 2024, null);
      expect(withSignal).toBe(noSignal);
    } finally {
      if (prev === undefined) delete process.env.GEM_RATE_MULTIPLIER_ENABLED;
      else process.env.GEM_RATE_MULTIPLIER_ENABLED = prev;
    }
  });
});

describe("logGemRateSignalSkipped — low-confidence telemetry", () => {
  it("emits gem_rate_signal_skipped when signal exists but confidence is low + grade is top", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 2 observations = low confidence
    const sig = computeGemRateFromObservations([
      { grade: "PSA 10", price: 200 },
      { grade: "PSA 9", price: 100 },
    ]);
    getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
    const emitted = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gem_rate_signal_skipped"));
    expect(emitted.length).toBeGreaterThan(0);
    const payload = JSON.parse(emitted[0]);
    expect(payload.event).toBe("gem_rate_signal_skipped");
    expect(payload.gradingCompany).toBe("PSA");
    expect(payload.grade).toBe("10");
    expect(payload.confidence).toBe("low");
    expect(payload.totalGradedObserved).toBe(2);
    expect(payload.reason).toBe("low-confidence");
    spy.mockRestore();
  });

  it("does NOT emit skipped event for mid-tier grades even when signal is low", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sig = computeGemRateFromObservations([
      { grade: "PSA 10", price: 200 },
      { grade: "PSA 9", price: 100 },
    ]);
    getGraderPremium("PSA", "9", 50, "base", 2024, null, sig);
    const emitted = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gem_rate_signal_skipped"));
    expect(emitted.length).toBe(0);
    spy.mockRestore();
  });

  it("does NOT emit skipped event when the applied event fires (mutually exclusive)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sig = computeGemRateFromObservations([
      ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
    const skipped = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gem_rate_signal_skipped"));
    const applied = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gem_rate_multiplier_applied"));
    expect(skipped.length).toBe(0);
    expect(applied.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});

describe("logGemRateMultiplierApplied — telemetry emission", () => {
  it("emits gem_rate_multiplier_applied when the short-circuit fires", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sig = computeGemRateFromObservations([
      ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    getGraderPremium("PSA", "10", 50, "base", 2024, null, sig);
    const emitted = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gem_rate_multiplier_applied"));
    expect(emitted.length).toBeGreaterThan(0);
    const payload = JSON.parse(emitted[0]);
    expect(payload.event).toBe("gem_rate_multiplier_applied");
    expect(payload.gradingCompany).toBe("PSA");
    expect(payload.grade).toBe("10");
    expect(payload.gemRate).toBeCloseTo(0.1, 2);
    expect(payload.gemRateBand).toBe("10-25%");
    expect(payload.confidence).toBe("high");
    expect(payload.totalGradedObserved).toBe(40);
    expect(payload.formulaMultiplier).toBeGreaterThan(5);
    expect(payload.setBump).toBe(1);
    expect(payload.finalMultiplier).toBe(payload.formulaMultiplier);
    spy.mockRestore();
  });

  it("does NOT emit when the short-circuit doesn't fire (mid-tier grade)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sig = computeGemRateFromObservations([
      ...Array.from({ length: 4 }, () => ({ grade: "PSA 10", price: 200 })),
      ...Array.from({ length: 36 }, () => ({ grade: "PSA 9", price: 100 })),
    ]);
    getGraderPremium("PSA", "9", 50, "base", 2024, null, sig);
    const emitted = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gem_rate_multiplier_applied"));
    expect(emitted.length).toBe(0);
    spy.mockRestore();
  });
});

describe("buildGemRateSignalFromPricing — pricing walker", () => {
  it("counts base-scope graded observations across companies + grades", () => {
    const pricing = mkPricing([
      { company: "PSA", grade: "10", price: 200 },
      { company: "PSA", grade: "10", price: 210 },
      { company: "PSA", grade: "9", price: 100 },
      { company: "PSA", grade: "9", price: 105 },
      { company: "BGS", grade: "9.5", price: 190 },
    ]);
    const sig = buildGemRateSignalFromPricing(pricing, "test-card");
    expect(sig).not.toBeNull();
    expect(sig!.totalGradedObserved).toBe(5);
    // PSA 10 x 2 + BGS 9.5 x 1 = 3 top grades
    expect(sig!.topGradeObserved).toBe(3);
    expect(sig!.gemRate).toBeCloseTo(0.6, 2);
    expect(sig!.gemRateBand).toBe(">=50%");
  });

  it("excludes parallel-tagged records from the base-scope pool", () => {
    // Same 5 obs but 3 of the PSA 10s are Blue Refractor (parallel_id set).
    const parallelRec = mkRec("PSA 10 Blue Refractor", 400, "blue-p-id");
    const pricing: CardsightPricingResponse = {
      card: { card_id: "x", name: "x", number: "1" } as any,
      raw: { count: 0, records: [] },
      graded: [{
        company_name: "PSA",
        grades: [
          { grade_value: "10", records: [mkRec("PSA 10 base", 200), mkRec("PSA 10 base", 210), parallelRec] },
          { grade_value: "9", records: [mkRec("PSA 9 base", 100), mkRec("PSA 9 base", 105)] },
        ],
      }] as any,
      meta: { total_records: 0, last_sale_date: null },
    } as CardsightPricingResponse;
    const sig = buildGemRateSignalFromPricing(pricing, "x");
    expect(sig).not.toBeNull();
    // Base-only: 2 PSA 10 + 2 PSA 9 = 4 observed; 2 gems.
    expect(sig!.totalGradedObserved).toBe(4);
    expect(sig!.topGradeObserved).toBe(2);
    expect(sig!.gemRate).toBeCloseTo(0.5, 2);
  });

  it("empty pricing.graded → null signal", () => {
    const pricing: CardsightPricingResponse = {
      card: { card_id: "x", name: "x", number: "1" } as any,
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    } as CardsightPricingResponse;
    expect(buildGemRateSignalFromPricing(pricing, "x")).toBeNull();
  });
});
