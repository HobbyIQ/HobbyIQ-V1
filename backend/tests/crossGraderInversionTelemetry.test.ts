// CF-CROSS-GRADER-INVERSION-TELEMETRY (2026-06-30) — pins the cross-grader
// inversion detection in detectCrossGraderInversions.
//
// Same-grader inversions (PSA 10 < PSA 9) are STRUCTURALLY impossible and
// trigger reconstruction (CF-CROSS-OBSERVED-INVERSION-GUARD). Cross-grader
// inversions (PSA 10 < BGS 10, BGS 10 < CGC 10, etc.) can be REAL —
// grader prestige varies by card type, era, and market segment. We detect
// + log but do NOT reconstruct. A follow-up CF can add reconstruction
// once the KQL patterns surface which inversion classes are quirks vs
// genuine market signals.
//
// THIS FILE PINS:
//   1. detectCrossGraderInversions: numeric grades only, same tier only,
//      >=2 comps per side, >=5% AND >=$5 margin
//   2. Multiple grader pairs at same tier → multiple events
//   3. No false positives: same-grader pairs, sub-threshold margins,
//      thin comps, non-numeric grades
//   4. logCrossGraderInversionObserved: JSON shape + defensive failure

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// detectCrossGraderInversions is module-private; we test through
// buildGradeBreakdown's telemetry emission (the only public path).
import {
  buildGradeBreakdown,
  logCrossGraderInversionObserved,
  type GradeBreakdownEntry,
  type CrossGraderInversionEvent,
} from "../src/services/compiq/marketRead.service.js";
import type { CardsightPricingResponse } from "../src/services/compiq/catalogSource.js";

function makePricingWith(graded: Array<{ grader: string; grade: string; prices: number[] }>): CardsightPricingResponse {
  return {
    card: {
      card_id: "test-card",
      name: "Test Player",
      number: "1",
      set: { set_id: "test", name: "Test Set", year: "2025", release: "Test" },
    } as never,
    raw: { count: 0, records: [] },
    graded: graded.map(({ grader, grade, prices }) => ({
      company_name: grader,
      grades: [
        {
          grade_value: grade,
          count: prices.length,
          records: prices.map((p, i) => ({
            title: `${grader} ${grade} sample ${i}`,
            price: p,
            date: "2026-06-15T00:00:00Z",
            source: "ebay",
            url: null,
            parallel_id: null,
          } as never)),
        },
      ],
    })),
    meta: { total_records: 0, last_sale_date: null },
  } as never;
}

describe("CF-CROSS-GRADER-INVERSION-TELEMETRY — detection via buildGradeBreakdown", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  function capturedEvents(): Array<{ event: string } & Record<string, unknown>> {
    return logSpy.mock.calls
      .map((c) => {
        try { return JSON.parse(String(c[0])); } catch { return null; }
      })
      .filter((p): p is Record<string, unknown> => p != null && typeof p === "object");
  }

  it("PSA 10 ($500) vs BGS 10 ($1000) → cross-grader event emitted, no reconstruction", () => {
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [500, 510, 520, 530] },
      { grader: "BGS", grade: "10", prices: [1000, 1010, 1020, 1030] },
    ]);
    const entries = buildGradeBreakdown(pricing, null);
    // Both entries preserved (no reconstruction — telemetry only)
    expect(entries.find((e) => e.grader === "PSA")?.median).toBe(515);
    expect(entries.find((e) => e.grader === "BGS")?.median).toBe(1015);
    // Cross-grader event emitted
    const ev = capturedEvents().find((p) => p.event === "cross_grader_inversion_observed");
    expect(ev).toBeDefined();
    expect(ev!.higherGrader).toBe("BGS");
    expect(ev!.lowerGrader).toBe("PSA");
    expect(ev!.numericGrade).toBe("10");
    expect(ev!.marginPct).toBeCloseTo(97.0, 0);
  });

  it("Three graders at same tier → multiple pairwise events", () => {
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [100, 110, 120] },
      { grader: "BGS", grade: "10", prices: [200, 210, 220] },
      { grader: "SGC", grade: "10", prices: [50, 55, 60] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    // 3 pairs: PSA-BGS, PSA-SGC, BGS-SGC — all above 5% margin
    expect(events.length).toBe(3);
  });

  it("Within 5% margin → no event (noise filter)", () => {
    // PSA 10 = $103, BGS 10 = $100. 3% margin — below threshold.
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [102, 103, 104] },
      { grader: "BGS", grade: "10", prices: [99, 100, 101] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    expect(events).toEqual([]);
  });

  it("Absolute margin < $5 → no event (low-value noise)", () => {
    // PSA 10 = $12, BGS 10 = $10. 20% margin BUT only $2 absolute.
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [11, 12, 13] },
      { grader: "BGS", grade: "10", prices: [9, 10, 11] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    expect(events).toEqual([]);
  });

  it("Thin comps (n<2) → entry skipped from comparison", () => {
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [1000] },  // n=1, skipped
      { grader: "BGS", grade: "10", prices: [500, 510, 520] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    expect(events).toEqual([]);
  });

  it("Same-grader pair (PSA 10 vs PSA 9) → NO cross-grader event (different grade tier)", () => {
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [100, 110, 120] },
      { grader: "PSA", grade: "9", prices: [200, 210, 220] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    expect(events).toEqual([]);
    // Note: this scenario WOULD fire same-grader reconstruction (CF-CROSS-
    // OBSERVED-INVERSION-GUARD) — but that's a different event entirely.
  });

  it("Different numeric grades across graders (PSA 10 vs BGS 9) → no cross-grader event", () => {
    // Different tier comparisons are out of scope — we only compare
    // same-numeric-grade across different graders.
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [100, 110, 120] },
      { grader: "BGS", grade: "9", prices: [500, 510, 520] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    expect(events).toEqual([]);
  });

  it("Non-numeric grade (Authentic) → skipped", () => {
    const pricing = makePricingWith([
      { grader: "PSA", grade: "Authentic", prices: [50, 60, 70] },
      { grader: "BGS", grade: "Authentic", prices: [500, 510, 520] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = capturedEvents().filter((p) => p.event === "cross_grader_inversion_observed");
    expect(events).toEqual([]);
  });
});

describe("CF-CROSS-GRADER-INVERSION-TELEMETRY — logCrossGraderInversionObserved JSON shape", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits all expected fields", () => {
    const event: CrossGraderInversionEvent = {
      higherGrader: "BGS",
      lowerGrader: "PSA",
      numericGrade: "10",
      higherMedian: 1000,
      higherCount: 5,
      lowerMedian: 500,
      lowerCount: 12,
      marginPct: 100.0,
    };
    logCrossGraderInversionObserved({
      source: "buildGradeBreakdown",
      player: "Mike Trout",
      cardId: "test-trout",
      event,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.event).toBe("cross_grader_inversion_observed");
    expect(payload.source).toBe("buildGradeBreakdown");
    expect(payload.player).toBe("Mike Trout");
    expect(payload.cardId).toBe("test-trout");
    expect(payload.higherGrader).toBe("BGS");
    expect(payload.lowerGrader).toBe("PSA");
    expect(payload.numericGrade).toBe("10");
    expect(payload.higherMedian).toBe(1000);
    expect(payload.higherCount).toBe(5);
    expect(payload.lowerMedian).toBe(500);
    expect(payload.lowerCount).toBe(12);
    expect(payload.marginPct).toBe(100);
    expect(typeof payload.timestamp).toBe("string");
  });

  it("never throws on serialization failure (defensive)", () => {
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => {
      logCrossGraderInversionObserved({
        source: "test",
        player: null,
        cardId: null,
        event: {
          higherGrader: "BGS",
          lowerGrader: "PSA",
          numericGrade: "10",
          higherMedian: 100,
          higherCount: 2,
          lowerMedian: 50,
          lowerCount: 2,
          marginPct: 100,
        },
      });
    }).not.toThrow();
    stringifySpy.mockRestore();
  });
});

describe("CF-CROSS-GRADER-INVERSION-TELEMETRY — same-grader guard still fires alongside", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("same-grader (PSA 10 < PSA 9) fires reconstruction AND cross-grader stays quiet", () => {
    const pricing = makePricingWith([
      { grader: "PSA", grade: "10", prices: [100, 110, 120] },
      { grader: "PSA", grade: "9", prices: [200, 210, 220, 230] },
    ]);
    buildGradeBreakdown(pricing, null);
    const events = logSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((p): p is Record<string, unknown> => p != null);
    const sameGraderEv = events.find((e) => e.event === "cross_observed_inversion_fired");
    const crossGraderEv = events.find((e) => e.event === "cross_grader_inversion_observed");
    expect(sameGraderEv).toBeDefined();
    expect(crossGraderEv).toBeUndefined();
  });
});
