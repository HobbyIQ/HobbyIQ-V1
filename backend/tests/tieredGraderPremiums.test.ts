// CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28) — pins the price-tiered grading
// multiplier table against the Prospects Live MiLB pitcher-prospect dataset.
//
// PRIOR-CF GAP: GRADER_PREMIUMS was flat per (company, grade) — same number
// regardless of raw price. Worked roughly at mid-tiers but systematically
// over-claimed at high raws (PSA 10 at $100+ raw: real 2.2× vs prior 4.0×)
// and under-claimed at low raws (PSA 9 at <$25: real 2.56× vs prior 1.7×).
// The flat table also missed the documented PSA 9 LOSS pattern above $50.
//
// THIS FILE PINS:
//   1. Tier boundaries map raw price → bucket correctly ($25 / $50 / $100).
//   2. Each tier's multiplier matches the article's reported figures.
//   3. Backward-compat: legacy callers without rawPrice get the fallback
//      (overall pitcher-prospect average), not a crash or 1.0.
//   4. Unknown company / grade gracefully returns 1.0.
//   5. Cross-grader scaling (BGS/SGC/CGC vs PSA) preserves the directional
//      hobby convention (BGS 10 > PSA 10 > SGC 10 > CGC 10 at same raw tier).
//
// Sources: Prospects Live — "Pitchers, Hitters, and PSA Grades: The PSA
// Grading Multiplier for MiLB Prospect Cards" (overall PSA 10 = 3.43×,
// PSA 9 = 1.70×, tiered breakdowns 4.9/3.6/2.8/2.2 and 2.56/1.5/<1/<1).

import { describe, expect, it } from "vitest";
import {
  getGraderPremium,
  rawPriceToGradeTier,
  logGraderRatioObserved,
} from "../src/services/compiq/compiqEstimate.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. TIER BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

describe("rawPriceToGradeTier — tier boundary mapping", () => {
  it("undefined / null / non-finite / non-positive → fallback", () => {
    expect(rawPriceToGradeTier(undefined)).toBe("fallback");
    expect(rawPriceToGradeTier(null)).toBe("fallback");
    expect(rawPriceToGradeTier(NaN)).toBe("fallback");
    expect(rawPriceToGradeTier(0)).toBe("fallback");
    expect(rawPriceToGradeTier(-5)).toBe("fallback");
  });

  it("price < $25 → '<25'", () => {
    expect(rawPriceToGradeTier(1)).toBe("<25");
    expect(rawPriceToGradeTier(15)).toBe("<25");
    expect(rawPriceToGradeTier(24.99)).toBe("<25");
  });

  it("price in [$25, $50) → '25-50'", () => {
    expect(rawPriceToGradeTier(25)).toBe("25-50");
    expect(rawPriceToGradeTier(35)).toBe("25-50");
    expect(rawPriceToGradeTier(49.99)).toBe("25-50");
  });

  it("price in [$50, $100) → '50-100'", () => {
    expect(rawPriceToGradeTier(50)).toBe("50-100");
    expect(rawPriceToGradeTier(75)).toBe("50-100");
    expect(rawPriceToGradeTier(99.99)).toBe("50-100");
  });

  it("price >= $100 → '100+'", () => {
    expect(rawPriceToGradeTier(100)).toBe("100+");
    expect(rawPriceToGradeTier(500)).toBe("100+");
    expect(rawPriceToGradeTier(10_000)).toBe("100+");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PSA TIERED VALUES (matches the Prospects Live article)
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — PSA tier values match the article's reported figures", () => {
  it("PSA 10 — tiered values: 5.0 / 3.6 / 2.8 / 2.2 / fallback 3.5 (PR #494 modern rebase)", () => {
    // CF-GRADER-PREMIUMS-MODERN-DEFAULTS (PR #494): PSA 10 lifted to
    // Drew's modern anchor. Tier boundaries unchanged; slab-floor tier
    // <$25 lifted 4.9 → 5.0; fallback lifted 3.43 → 3.5.
    expect(getGraderPremium("PSA", "10", 10)).toBe(5.0);
    expect(getGraderPremium("PSA", "10", 35)).toBe(3.6);
    expect(getGraderPremium("PSA", "10", 75)).toBe(2.8);
    expect(getGraderPremium("PSA", "10", 500)).toBe(2.2);
    expect(getGraderPremium("PSA", "10")).toBe(3.5); // fallback
  });

  it("PSA 9 — tiered values: 2.56 / 1.5 / 0.95 / 0.85 / fallback 1.70 (article confirms <1.0 at $50+)", () => {
    expect(getGraderPremium("PSA", "9", 10)).toBe(2.56);
    expect(getGraderPremium("PSA", "9", 35)).toBe(1.5);
    expect(getGraderPremium("PSA", "9", 75)).toBe(0.95);
    expect(getGraderPremium("PSA", "9", 500)).toBe(0.85);
    expect(getGraderPremium("PSA", "9")).toBe(1.70);
  });

  it("PSA 8 — modern PSA 8 = Raw hard override (PR #494 CF-PSA8-EQUALS-RAW)", () => {
    // CF-PSA8-EQUALS-RAW (Drew, 2026-07-15, PR #494): PSA 8 = Raw as a
    // hard business rule for modern (year >= 1990 OR unknown). The
    // article's "consistently loses value" observation is overridden by
    // Drew's product decision. Vintage still routes through vintage
    // table where PSA 8 correctly returns 10-30× raw.
    expect(getGraderPremium("PSA", "8", 10)).toBe(1.0);
    expect(getGraderPremium("PSA", "8", 35)).toBe(1.0);
    expect(getGraderPremium("PSA", "8", 75)).toBe(1.0);
    expect(getGraderPremium("PSA", "8", 500)).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BACKWARD-COMPAT — callers without rawPrice get fallback (overall avg)
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — backward-compat fallback path", () => {
  it("PSA 10 / no rawPrice → 3.5 (PR #494 modern anchor)", () => {
    // CF-GRADER-PREMIUMS-MODERN-DEFAULTS (PR #494): fallback 3.43 → 3.5
    expect(getGraderPremium("PSA", "10")).toBe(3.5);
    expect(getGraderPremium("PSA", "10", null)).toBe(3.5);
    expect(getGraderPremium("PSA", "10", undefined)).toBe(3.5);
  });

  it("PSA 9 / no rawPrice → 1.70 (overall average, equal to prior flat 1.7)", () => {
    expect(getGraderPremium("PSA", "9")).toBe(1.70);
  });

  it("BGS 9.5 / no rawPrice → 3.05 (derived from PSA 10 × 0.89 average)", () => {
    expect(getGraderPremium("BGS", "9.5")).toBe(3.05);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNKNOWN INPUTS — defensive defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — unknown inputs default to 1.0 (raw-equivalent)", () => {
  it("unknown company → 1.0", () => {
    expect(getGraderPremium("UNKNOWN", "10", 50)).toBe(1.0);
  });

  it("unknown grade → 1.0", () => {
    expect(getGraderPremium("PSA", "999", 50)).toBe(1.0);
  });

  it("null company → 1.0", () => {
    expect(getGraderPremium(null, "10", 50)).toBe(1.0);
  });

  it("null grade → 1.0", () => {
    expect(getGraderPremium("PSA", null, 50)).toBe(1.0);
  });

  it("case-insensitive on company name", () => {
    expect(getGraderPremium("psa", "10", 50)).toBe(getGraderPremium("PSA", "10", 50));
    expect(getGraderPremium("Psa", "10", 500)).toBe(getGraderPremium("PSA", "10", 500));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CROSS-GRADER ORDERING — preserves hobby convention
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — cross-grader directional ordering at same tier", () => {
  it("BGS 10 > PSA 10 (Black Label premium)", () => {
    const psa10 = getGraderPremium("PSA", "10", 50)!;
    const bgs10 = getGraderPremium("BGS", "10", 50)!;
    expect(bgs10).toBeGreaterThan(psa10);
  });

  it("PSA 10 > SGC 10 (SGC discount vs PSA)", () => {
    const psa10 = getGraderPremium("PSA", "10", 50)!;
    const sgc10 = getGraderPremium("SGC", "10", 50)!;
    expect(psa10).toBeGreaterThan(sgc10);
  });

  it("SGC 10 > CGC 10 (CGC further discount)", () => {
    const sgc10 = getGraderPremium("SGC", "10", 50)!;
    const cgc10 = getGraderPremium("CGC", "10", 50)!;
    expect(sgc10).toBeGreaterThan(cgc10);
  });

  it("ordering preserved at every tier", () => {
    for (const raw of [10, 35, 75, 500]) {
      const psa10 = getGraderPremium("PSA", "10", raw)!;
      const bgs10 = getGraderPremium("BGS", "10", raw)!;
      const sgc10 = getGraderPremium("SGC", "10", raw)!;
      const cgc10 = getGraderPremium("CGC", "10", raw)!;
      expect(bgs10, `raw=${raw}`).toBeGreaterThan(psa10);
      expect(psa10, `raw=${raw}`).toBeGreaterThan(sgc10);
      expect(sgc10, `raw=${raw}`).toBeGreaterThan(cgc10);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. MONOTONICITY — multiplier DECREASES as raw price increases (PSA 10 & 9)
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — monotonic decrease in multiplier as raw rises", () => {
  // Article's central finding: as raw price rises, PSA 10 premium SHRINKS
  // (4.9 → 3.6 → 2.8 → 2.2). PSA 9 even more aggressively (2.56 → 1.5 → 0.95 → 0.85).
  it("PSA 10 multiplier strictly decreases across the four tier breakpoints", () => {
    const m10_low = getGraderPremium("PSA", "10", 10)!;
    const m10_mid = getGraderPremium("PSA", "10", 35)!;
    const m10_upper = getGraderPremium("PSA", "10", 75)!;
    const m10_top = getGraderPremium("PSA", "10", 500)!;
    expect(m10_low).toBeGreaterThan(m10_mid);
    expect(m10_mid).toBeGreaterThan(m10_upper);
    expect(m10_upper).toBeGreaterThan(m10_top);
  });

  it("PSA 9 multiplier strictly decreases — eventually drops below 1.0 (value loss)", () => {
    const m9_low = getGraderPremium("PSA", "9", 10)!;
    const m9_mid = getGraderPremium("PSA", "9", 35)!;
    const m9_upper = getGraderPremium("PSA", "9", 75)!;
    const m9_top = getGraderPremium("PSA", "9", 500)!;
    expect(m9_low).toBeGreaterThan(m9_mid);
    expect(m9_mid).toBeGreaterThan(m9_upper);
    expect(m9_upper).toBeGreaterThanOrEqual(m9_top);
    // article-confirmed: at $50+ raw, PSA 9 trades BELOW the raw value
    expect(m9_upper).toBeLessThan(1.0);
    expect(m9_top).toBeLessThan(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. TELEMETRY — logGraderRatioObserved emits the right event shape
// ─────────────────────────────────────────────────────────────────────────────

describe("logGraderRatioObserved — telemetry for per-player calibration", () => {
  let capturedLogs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    capturedLogs = [];
    console.log = (...args: any[]) => {
      capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("emits a graded_ratio_observed event with computed ratio + tier", () => {
    logGraderRatioObserved({
      source: "test",
      player: "Eric Hartman",
      cardId: "test-card-id",
      gradingCompany: "PSA",
      grade: "10",
      rawAnchor: 50,
      gradedValue: 150,
    });
    expect(capturedLogs).toHaveLength(1);
    const event = JSON.parse(capturedLogs[0]!);
    expect(event.event).toBe("graded_ratio_observed");
    expect(event.player).toBe("Eric Hartman");
    expect(event.gradingCompany).toBe("PSA");
    expect(event.grade).toBe("10");
    expect(event.ratio).toBe(3); // 150 / 50
    expect(event.tier).toBe("50-100");
  });

  it("skips when rawAnchor or gradedValue is zero/negative (no spurious ratios)", () => {
    logGraderRatioObserved({
      source: "test",
      player: "Test",
      cardId: "test",
      gradingCompany: "PSA",
      grade: "10",
      rawAnchor: 0,
      gradedValue: 100,
    });
    logGraderRatioObserved({
      source: "test",
      player: "Test",
      cardId: "test",
      gradingCompany: "PSA",
      grade: "10",
      rawAnchor: 50,
      gradedValue: -10,
    });
    expect(capturedLogs).toHaveLength(0);
  });
});

// Import the lifecycle hooks vitest needs.
import { beforeEach, afterEach } from "vitest";
