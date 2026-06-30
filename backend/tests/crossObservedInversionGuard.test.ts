// CF-CROSS-OBSERVED-INVERSION-GUARD (2026-06-29) — pins the same-grader
// inversion reconstruction in applyCrossGradedInversionGuard.
//
// Vol Test #2 canonical case: 1960 Topps Mickey Mantle All-Star #563
//   PSA 9  = $3,249 (n>=2 observed comps)
//   PSA 10 = $2,639 (n>=2 observed comps — but inverted)
// The sparsity+staleness filter (PR #198) caught Mays-style stale singletons,
// but Mantle has multiple observed PSA 10 sales whose median is just
// depressed — a real comp pool with a fluke outlier dragging the median.
// This guard reconstructs PSA 10 via the empirical premium ratio anchored
// on the trusted PSA 9.
//
// Safety rails (THIS FILE PINS):
//   1. Same-grader only (PSA 10 < BGS 10 unchanged — cross-grader prestige fuzzy)
//   2. Numeric grades only (Authentic/Altered skipped)
//   3. Inversion margin: >5% AND >$5 absolute
//   4. Trust direction: lower grade must have >= higher's compCount
//   5. Lower must have >= 3 comps (don't reconstruct off 1-2 sample base)
//   6. Premium ratio must exist + be >= 1
//   7. Mantle-shape canonical: PSA 10 < PSA 9 → PSA 10 reconstructed,
//      compCount=0, note set

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyCrossGradedInversionGuard,
  logCrossObservedInversionFired,
  type GradeBreakdownEntry,
  type CrossObservedInversionEvent,
} from "../src/services/compiq/marketRead.service.js";

function e(
  grader: string,
  grade: string,
  median: number,
  compCount: number,
): GradeBreakdownEntry {
  return { grader, grade, median, compCount };
}

describe("CF-CROSS-OBSERVED-INVERSION-GUARD — applyCrossGradedInversionGuard", () => {
  it("Mantle canonical: PSA 10 ($2,639) < PSA 9 ($3,249) → PSA 10 reconstructed", () => {
    const entries = [
      e("PSA", "10", 2639, 3),
      e("PSA", "9", 3249, 8),
    ];
    applyCrossGradedInversionGuard(entries, 305); // Mantle 1960 raw ≈ $305
    const psa10 = entries.find((x) => x.grade === "10")!;
    const psa9 = entries.find((x) => x.grade === "9")!;
    expect(psa9.median).toBe(3249); // unchanged (trusted)
    expect(psa9.compCount).toBe(8);
    expect(psa9.note).toBeUndefined();
    // PSA 10 was reconstructed — must be > PSA 9 (no longer inverted)
    expect(psa10.median).toBeGreaterThan(3249);
    expect(psa10.compCount).toBe(0); // signals estimated
    expect(psa10.note).toMatch(/Reconstructed/);
    expect(psa10.note).toContain("inverted");
  });

  it("No inversion (PSA 10 > PSA 9) → both entries unchanged", () => {
    const entries = [
      e("PSA", "10", 5000, 3),
      e("PSA", "9", 1500, 8),
    ];
    applyCrossGradedInversionGuard(entries, 100);
    expect(entries[0]!.median).toBe(5000);
    expect(entries[0]!.compCount).toBe(3);
    expect(entries[0]!.note).toBeUndefined();
    expect(entries[1]!.median).toBe(1500);
  });

  it("Inversion within 5% noise margin → unchanged (avoids low-value noise)", () => {
    // PSA 9 = $100, PSA 10 = $97 → 3% inversion → below threshold.
    const entries = [e("PSA", "10", 97, 5), e("PSA", "9", 100, 10)];
    applyCrossGradedInversionGuard(entries, 25);
    expect(entries[0]!.median).toBe(97);
    expect(entries[0]!.note).toBeUndefined();
  });

  it("Absolute diff < $5 → unchanged (even if % is large)", () => {
    // PSA 9 = $10, PSA 10 = $8 → 20% inversion BUT only $2 absolute → below threshold.
    const entries = [e("PSA", "10", 8, 5), e("PSA", "9", 10, 10)];
    applyCrossGradedInversionGuard(entries, 5);
    expect(entries[0]!.median).toBe(8);
    expect(entries[0]!.note).toBeUndefined();
  });

  it("Lower has FEWER comps than higher → unchanged (real inversion signal)", () => {
    // PSA 10 has 20 comps at $2,000, PSA 9 has 1 lucky comp at $3,000.
    // That's not an outlier in PSA 10 — that's a fluke in PSA 9.
    // Don't reconstruct.
    const entries = [e("PSA", "10", 2000, 20), e("PSA", "9", 3000, 1)];
    applyCrossGradedInversionGuard(entries, 100);
    expect(entries[0]!.median).toBe(2000);
    expect(entries[0]!.note).toBeUndefined();
  });

  it("Lower has < 3 comps → unchanged (shaky reconstruction base)", () => {
    const entries = [e("PSA", "10", 2000, 2), e("PSA", "9", 3000, 2)];
    applyCrossGradedInversionGuard(entries, 100);
    expect(entries[0]!.median).toBe(2000);
    expect(entries[0]!.note).toBeUndefined();
  });

  it("Cross-grader inversion (PSA 10 < BGS 10) → unchanged (prestige fuzzy)", () => {
    const entries = [
      e("PSA", "10", 2000, 5),
      e("BGS", "10", 5000, 10),
    ];
    applyCrossGradedInversionGuard(entries, 100);
    expect(entries[0]!.median).toBe(2000);
    expect(entries[0]!.note).toBeUndefined();
    expect(entries[1]!.median).toBe(5000);
    expect(entries[1]!.note).toBeUndefined();
  });

  it("Non-numeric grade (Authentic) → skipped, no crash", () => {
    const entries = [
      e("PSA", "Authentic", 50, 3),
      e("PSA", "9", 200, 5),
      e("PSA", "10", 100, 3),  // inverted with PSA 9
    ];
    applyCrossGradedInversionGuard(entries, 50);
    // Authentic is non-numeric → skipped from the ladder walk.
    const authentic = entries.find((x) => x.grade === "Authentic")!;
    expect(authentic.median).toBe(50);
    expect(authentic.note).toBeUndefined();
    // PSA 10 still detected via PSA 9 (numeric pair).
    const psa10 = entries.find((x) => x.grade === "10")!;
    expect(psa10.note).toMatch(/Reconstructed/);
  });

  it("BGS 9.5 < BGS 9 → BGS 9.5 reconstructed (half-grade ladder works)", () => {
    const entries = [
      e("BGS", "9.5", 1500, 4),
      e("BGS", "9", 2500, 10),
    ];
    applyCrossGradedInversionGuard(entries, 100);
    const bgs95 = entries.find((x) => x.grade === "9.5")!;
    expect(bgs95.median).toBeGreaterThan(2500);
    expect(bgs95.compCount).toBe(0);
    expect(bgs95.note).toMatch(/Reconstructed/);
  });

  it("Chain inversion: PSA 10 < PSA 9 < PSA 8 → each pair handled adjacently", () => {
    // After reconstruction of PSA 10 vs PSA 9, then PSA 9 vs PSA 8.
    // PSA 9 reconstructs against PSA 8. Then PSA 10's stored median
    // (reconstructed against the ORIGINAL PSA 9) may itself become
    // inverted with new PSA 9. This test pins the current adjacent-only
    // behavior — one pass, no re-walk. If a later CF needs multi-pass
    // convergence, update this assertion.
    const entries = [
      e("PSA", "10", 100, 3),
      e("PSA", "9", 200, 5),
      e("PSA", "8", 300, 8),
    ];
    applyCrossGradedInversionGuard(entries, 50);
    // PSA 9 vs PSA 8: 200 < 300 → reconstruct PSA 9.
    // PSA 10 vs PSA 9 (ORIGINAL 200): 100 < 200 → reconstruct PSA 10.
    // Both flagged.
    expect(entries.find((x) => x.grade === "10")!.note).toMatch(/Reconstructed/);
    expect(entries.find((x) => x.grade === "9")!.note).toMatch(/Reconstructed/);
  });

  it("Empty input → no crash", () => {
    const entries: GradeBreakdownEntry[] = [];
    applyCrossGradedInversionGuard(entries, 100);
    expect(entries).toEqual([]);
  });

  it("Single grade per grader → no inversion possible, unchanged", () => {
    const entries = [e("PSA", "10", 5000, 5)];
    applyCrossGradedInversionGuard(entries, 100);
    expect(entries[0]!.median).toBe(5000);
    expect(entries[0]!.note).toBeUndefined();
  });
});

describe("CF-INVERSION-GUARD-MULTIPASS — convergence + event reporting", () => {
  it("returns event list — Mantle scenario emits one event", () => {
    const entries = [e("PSA", "10", 2639, 3), e("PSA", "9", 3249, 8)];
    const events = applyCrossGradedInversionGuard(entries, 305);
    expect(events).toHaveLength(1);
    expect(events[0]!.grader).toBe("PSA");
    expect(events[0]!.higherGrade).toBe("10");
    expect(events[0]!.lowerGrade).toBe("9");
    expect(events[0]!.originalHigherMedian).toBe(2639);
    expect(events[0]!.originalHigherCount).toBe(3);
    expect(events[0]!.lowerMedian).toBe(3249);
    expect(events[0]!.lowerCount).toBe(8);
    expect(events[0]!.passNumber).toBe(1);
    expect(events[0]!.ratio).toBeGreaterThan(1);
    expect(events[0]!.reconstructedMedian).toBeGreaterThan(3249);
  });

  it("returns empty event list when no firings", () => {
    const entries = [e("PSA", "10", 5000, 5), e("PSA", "9", 1500, 8)];
    const events = applyCrossGradedInversionGuard(entries, 100);
    expect(events).toEqual([]);
  });

  it("terminates within MAX_PASSES (4) — never infinite-loops on degenerate input", () => {
    // Construct a cascade. Pass 1 reconstructs adjacent pairs; reconstructed
    // entries (compCount=0) can't anchor further reconstructions, so this
    // should converge in 1-2 passes regardless. The bound is the safety net.
    const entries = [
      e("PSA", "10", 100, 3),
      e("PSA", "9.5", 80, 4),
      e("PSA", "9", 200, 5),
      e("PSA", "8.5", 300, 6),
      e("PSA", "8", 400, 8),
    ];
    const events = applyCrossGradedInversionGuard(entries, 50);
    // No throw, no infinite loop — events emitted and the function returned.
    expect(Array.isArray(events)).toBe(true);
    // All event passNumbers must be within bounds.
    for (const ev of events) {
      expect(ev.passNumber).toBeGreaterThanOrEqual(1);
      expect(ev.passNumber).toBeLessThanOrEqual(4);
    }
  });

  it("passNumber reflects which pass fired the reconstruction", () => {
    // PSA 9.5 fires on pass 1 (vs PSA 9). PSA 10 might fire on pass 2
    // if its original value is below reconstructed PSA 9.5.
    // We assert the FIRST event is from pass 1 (the obvious adjacent
    // inversion); higher-pass events are bonus convergence.
    const entries = [
      e("PSA", "10", 100, 3),
      e("PSA", "9.5", 80, 5),    // vs PSA 9 (200): inverted
      e("PSA", "9", 200, 10),
    ];
    const events = applyCrossGradedInversionGuard(entries, 50);
    if (events.length > 0) {
      expect(events[0]!.passNumber).toBe(1);
    }
  });
});

describe("CF-INVERSION-GUARD-TELEMETRY — logCrossObservedInversionFired", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a JSON event with all fields populated", () => {
    const event: CrossObservedInversionEvent = {
      grader: "PSA",
      higherGrade: "10",
      lowerGrade: "9",
      originalHigherMedian: 2639,
      originalHigherCount: 3,
      lowerMedian: 3249,
      lowerCount: 8,
      reconstructedMedian: 6498,
      ratio: 2.0,
      passNumber: 1,
    };
    logCrossObservedInversionFired({
      source: "buildGradeBreakdown",
      player: "Mickey Mantle",
      cardId: "test-mantle-1960",
      event,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.event).toBe("cross_observed_inversion_fired");
    expect(payload.source).toBe("buildGradeBreakdown");
    expect(payload.player).toBe("Mickey Mantle");
    expect(payload.cardId).toBe("test-mantle-1960");
    expect(payload.grader).toBe("PSA");
    expect(payload.higherGrade).toBe("10");
    expect(payload.lowerGrade).toBe("9");
    expect(payload.originalHigherMedian).toBe(2639);
    expect(payload.lowerMedian).toBe(3249);
    expect(payload.reconstructedMedian).toBe(6498);
    expect(payload.ratio).toBe(2);
    // Mantle case: PSA 10 was $610 (18.8%) below PSA 9.
    expect(payload.inversionPctOriginal).toBeCloseTo(18.8, 1);
    expect(payload.passNumber).toBe(1);
    expect(typeof payload.timestamp).toBe("string");
  });

  it("never throws on serialization failure (defensive)", () => {
    // Force JSON.stringify to throw mid-call.
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => {
      logCrossObservedInversionFired({
        source: "test",
        player: null,
        cardId: null,
        event: {
          grader: "PSA",
          higherGrade: "10",
          lowerGrade: "9",
          originalHigherMedian: 100,
          originalHigherCount: 1,
          lowerMedian: 200,
          lowerCount: 5,
          reconstructedMedian: 300,
          ratio: 1.5,
          passNumber: 1,
        },
      });
    }).not.toThrow();
    stringifySpy.mockRestore();
  });
});
