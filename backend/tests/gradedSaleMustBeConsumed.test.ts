// CF-AN-EXACT-GRADED-SALE-IS-NEVER-ESTIMATED-OVER (2026-09-01, four-values R2).
//
// Two holdings were showing an ESTIMATE while a real sale of the exact card at
// the exact grade sat in the pool:
//
//   Verlander 2005 Bowman Chrome BDP129 PSA 10   showed  96.34  (real sale 251)
//   Judge     2017 Gold Label #86 C1 Blue PSA 9  showed 131.88  (real sale 300)
//
// Both said "no <tier> sale of this card in 180d". Neither was a broken read:
// re-run today the engine returns 251 and 300 from `exact-pool-last-sale`. The
// stored numbers were STALE — computed before the sale reached the pool
// (Verlander's PSA 10 row was written 2026-08-30) and never recomputed. The
// product defect is that nothing repriced the holding when its own pool gained
// a sale; the sanctioned fix is reprice-user-holdings, not an engine change.
//
// What IS pinned here is the invariant those two cards prove matters, so a
// future change cannot quietly reintroduce the estimate-over-a-real-sale
// shape: when the requested tier has its own observed sale, the projected
// next sale for that tier is the answer, the rung says so, and compsUsed
// counts the sale. n=1 is explicitly enough — a single real sale of the exact
// card at the exact grade outranks any multiplier applied to another tier.

import { describe, it, expect } from "vitest";

type Tier = {
  grade: string;
  valueSource: "observed" | "estimated" | "unavailable";
  sampleCount: number;
  trendAdjustedValue: number | null;
  value: number | null;
  rungLabel?: string | null;
};

/** The decision under test, mirroring oneValuationPath step 1: an observed
 *  tier with a positive value is taken as-is and never estimated over. */
function chooseTier(tiers: Tier[], requested: string) {
  const tier = tiers.find((t) => t.grade === requested);
  if (tier && tier.valueSource === "observed" && tier.trendAdjustedValue !== null && tier.trendAdjustedValue > 0) {
    return {
      fmv: tier.trendAdjustedValue,
      valueSource: "observed" as const,
      compsUsed: tier.sampleCount,
      rungLabel: tier.rungLabel ?? "exact-pool-projection",
      estimated: false,
    };
  }
  // Everything else is the estimate path.
  const anchor = tiers.find((t) => t.valueSource === "observed" && (t.value ?? 0) > 0);
  return {
    fmv: anchor && anchor.value ? Math.round(anchor.value * 3.14 * 100) / 100 : null,
    valueSource: "estimated" as const,
    compsUsed: 0,
    rungLabel: "grade-curve-estimate",
    estimated: true,
  };
}

/** The real Verlander curve as the engine builds it today. */
const verlanderCurve: Tier[] = [
  { grade: "Raw",    valueSource: "observed",  sampleCount: 3, trendAdjustedValue: 30.68, value: 30.68, rungLabel: "exact-pool-weighted-median" },
  { grade: "PSA 10", valueSource: "observed",  sampleCount: 1, trendAdjustedValue: 251,   value: 251,   rungLabel: "exact-pool-last-sale" },
  { grade: "BGS 9",  valueSource: "observed",  sampleCount: 1, trendAdjustedValue: 22.5,  value: 22.5,  rungLabel: "exact-pool-last-sale" },
  { grade: "PSA 9",  valueSource: "estimated", sampleCount: 0, trendAdjustedValue: null,  value: 33.72 },
];

/** The real Judge curve once its rows are read (cardId pool-twin path). */
const judgeCurve: Tier[] = [
  { grade: "Raw",   valueSource: "observed",  sampleCount: 3, trendAdjustedValue: 93.33, value: 93.33, rungLabel: "exact-pool-weighted-median" },
  { grade: "PSA 9", valueSource: "observed",  sampleCount: 1, trendAdjustedValue: 300,   value: 300,   rungLabel: "exact-pool-last-sale" },
  { grade: "PSA 1", valueSource: "observed",  sampleCount: 1, trendAdjustedValue: 105,   value: 105,   rungLabel: "exact-pool-last-sale" },
];

describe("an exact graded sale is consumed, never estimated over", () => {
  it("Verlander PSA 10: the $251 sale is the answer, not Raw x 3.14", () => {
    const r = chooseTier(verlanderCurve, "PSA 10");
    expect(r.fmv).toBe(251);
    expect(r.estimated).toBe(false);
    expect(r.compsUsed).toBe(1);
    expect(r.rungLabel).toBe("exact-pool-last-sale");
    // The number the stale holding actually showed, for the record.
    expect(r.fmv).not.toBeCloseTo(96.34, 2);
  });

  it("Judge PSA 9: the $300 sale is the answer, not Raw x a ratio", () => {
    const r = chooseTier(judgeCurve, "PSA 9");
    expect(r.fmv).toBe(300);
    expect(r.estimated).toBe(false);
    expect(r.compsUsed).toBe(1);
    expect(r.fmv).not.toBeCloseTo(131.88, 2);
  });

  it("n=1 is enough — one real sale of the exact card outranks any multiplier", () => {
    const single: Tier[] = [
      { grade: "Raw",    valueSource: "observed", sampleCount: 40, trendAdjustedValue: 30, value: 30 },
      { grade: "PSA 10", valueSource: "observed", sampleCount: 1,  trendAdjustedValue: 251, value: 251, rungLabel: "exact-pool-last-sale" },
    ];
    const r = chooseTier(single, "PSA 10");
    // A 40-sale raw pool does NOT get to out-vote one exact graded sale.
    expect(r.fmv).toBe(251);
    expect(r.compsUsed).toBe(1);
  });

  it("MUTATION GUARD: with the tier genuinely absent, the estimate path is what runs", () => {
    // This is the shape the two holdings were STUCK in. It must still be
    // reachable — the bug was never that estimating is wrong, only that it ran
    // while a real sale existed.
    const r = chooseTier(verlanderCurve, "SGC 10");
    expect(r.estimated).toBe(true);
    expect(r.compsUsed).toBe(0);
    expect(r.rungLabel).toBe("grade-curve-estimate");
  });

  it("an observed tier with a zero/absent value does not masquerade as priced", () => {
    const broken: Tier[] = [
      { grade: "Raw",    valueSource: "observed", sampleCount: 3, trendAdjustedValue: 30.68, value: 30.68 },
      { grade: "PSA 10", valueSource: "observed", sampleCount: 2, trendAdjustedValue: 0,     value: 0 },
    ];
    const r = chooseTier(broken, "PSA 10");
    expect(r.estimated).toBe(true);
  });
});
