// CF-SUB-RAW-INVERSION-TELEMETRY (2026-06-30) — pins the sub-raw
// inversion telemetry alongside the existing display note.
//
// The note ("Raw trades above X here — common for hot prospects") is
// shipped to iOS as a display-only string and has been in place since
// CF-CROSS-GRADE-COHERENCE additive (2026-06-12). This CF adds a
// structured event so KQL can aggregate by player/grader/grade/margin
// for seller-intelligence signals (e.g., "which prospects trade raw-
// above-graded most? — they're the hot speculation cards").
//
// THIS FILE PINS:
//   1. Event emitted when graded median < raw median (same scenario as
//      the existing note)
//   2. NO event when graded median >= raw median (the common case)
//   3. NO event when raw is absent (no observedRawMedian to compare)
//   4. Multiple sub-raw entries → multiple events (one per (grader,grade) pair)
//   5. logSubRawInversionObserved JSON shape + defensive serialization

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildGradeBreakdown,
  logSubRawInversionObserved,
  type SubRawInversionEvent,
} from "../src/services/compiq/marketRead.service.js";
import type { CardsightPricingResponse } from "../src/services/compiq/catalogSource.js";

function rec(price: number, parallel_id: string | null = null) {
  return {
    title: `sample $${price}`,
    price,
    date: "2026-06-15T00:00:00Z",
    source: "ebay",
    url: null,
    parallel_id,
  } as never;
}

function makePricing(opts: {
  raw?: number[];
  graded: Array<{ grader: string; grade: string; prices: number[] }>;
  cardName?: string;
  cardId?: string;
}): CardsightPricingResponse {
  return {
    card: {
      card_id: opts.cardId ?? "test-card",
      name: opts.cardName ?? "Test Player",
      number: "1",
      set: { set_id: "test", name: "Test Set", year: "2025", release: "Test" },
    } as never,
    raw: { count: (opts.raw ?? []).length, records: (opts.raw ?? []).map((p) => rec(p)) },
    graded: opts.graded.map(({ grader, grade, prices }) => ({
      company_name: grader,
      grades: [{ grade_value: grade, count: prices.length, records: prices.map((p) => rec(p)) }],
    })),
    meta: { total_records: 0, last_sale_date: null },
  } as never;
}

describe("CF-SUB-RAW-INVERSION-TELEMETRY — emission via buildGradeBreakdown", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  function subRawEvents() {
    return logSpy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((p): p is Record<string, unknown> => p != null && p.event === "sub_raw_inversion_observed");
  }

  it("graded median < raw median → event emitted + note attached", () => {
    // Hot prospect case: raw $100 median, PSA 9 $60 median (graded below raw)
    const pricing = makePricing({
      raw: [95, 100, 105],
      graded: [{ grader: "PSA", grade: "9", prices: [55, 60, 65] }],
      cardName: "Hot Prospect",
      cardId: "hp-1",
    });
    const entries = buildGradeBreakdown(pricing, null);
    const psa9 = entries.find((e) => e.grader === "PSA" && e.grade === "9");
    expect(psa9?.median).toBe(60);  // unmodified
    expect(psa9?.note).toMatch(/Raw trades above/);
    // Event fired
    const ev = subRawEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.grader).toBe("PSA");
    expect(ev[0]!.grade).toBe("9");
    expect(ev[0]!.gradeMedian).toBe(60);
    expect(ev[0]!.gradeCount).toBe(3);
    expect(ev[0]!.rawMedian).toBe(100);
    expect(ev[0]!.marginPct).toBe(40);  // (100-60)/100 * 100 = 40
    expect(ev[0]!.marginUSD).toBe(40);
    expect(ev[0]!.player).toBe("Hot Prospect");
    expect(ev[0]!.cardId).toBe("hp-1");
  });

  it("graded median >= raw median → no event (the common case)", () => {
    // Normal card: raw $100, PSA 10 $500
    const pricing = makePricing({
      raw: [95, 100, 105],
      graded: [{ grader: "PSA", grade: "10", prices: [495, 500, 505] }],
    });
    buildGradeBreakdown(pricing, null);
    expect(subRawEvents()).toEqual([]);
  });

  it("no raw records → no event (no baseline to compare against)", () => {
    const pricing = makePricing({
      raw: [],
      graded: [{ grader: "PSA", grade: "9", prices: [50, 60, 70] }],
    });
    buildGradeBreakdown(pricing, null);
    expect(subRawEvents()).toEqual([]);
  });

  it("multiple sub-raw entries → multiple events (one per grader/grade)", () => {
    const pricing = makePricing({
      raw: [100, 100, 100],
      graded: [
        { grader: "PSA", grade: "9", prices: [50, 50, 50] },
        { grader: "BGS", grade: "9", prices: [60, 60, 60] },
        { grader: "PSA", grade: "10", prices: [200, 200, 200] },  // not sub-raw
      ],
    });
    buildGradeBreakdown(pricing, null);
    const events = subRawEvents();
    expect(events).toHaveLength(2);
    const psa9Ev = events.find((e) => e.grader === "PSA" && e.grade === "9");
    const bgs9Ev = events.find((e) => e.grader === "BGS" && e.grade === "9");
    expect(psa9Ev?.marginUSD).toBe(50);
    expect(bgs9Ev?.marginUSD).toBe(40);
  });
});

describe("CF-SUB-RAW-INVERSION-TELEMETRY — logSubRawInversionObserved JSON shape", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits all expected fields", () => {
    const event: SubRawInversionEvent = {
      grader: "PSA",
      grade: "9",
      gradeMedian: 60,
      gradeCount: 5,
      rawMedian: 100,
      marginPct: 40.0,
      marginUSD: 40,
    };
    logSubRawInversionObserved({
      source: "buildGradeBreakdown",
      player: "Bobby Witt Jr.",
      cardId: "test-witt",
      event,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.event).toBe("sub_raw_inversion_observed");
    expect(payload.source).toBe("buildGradeBreakdown");
    expect(payload.player).toBe("Bobby Witt Jr.");
    expect(payload.cardId).toBe("test-witt");
    expect(payload.grader).toBe("PSA");
    expect(payload.grade).toBe("9");
    expect(payload.gradeMedian).toBe(60);
    expect(payload.gradeCount).toBe(5);
    expect(payload.rawMedian).toBe(100);
    expect(payload.marginPct).toBe(40);
    expect(payload.marginUSD).toBe(40);
    expect(typeof payload.timestamp).toBe("string");
  });

  it("never throws on serialization failure (defensive)", () => {
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => {
      logSubRawInversionObserved({
        source: "test",
        player: null,
        cardId: null,
        event: {
          grader: "PSA",
          grade: "9",
          gradeMedian: 60,
          gradeCount: 1,
          rawMedian: 100,
          marginPct: 40,
          marginUSD: 40,
        },
      });
    }).not.toThrow();
    stringifySpy.mockRestore();
  });
});
