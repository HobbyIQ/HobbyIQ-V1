// CF-PORTFOLIO-DAY-CHANGE (Drew, 2026-09-04) — "the portfolio bar should show
// the day change in $ and % with colour."
//
// The whole risk in a day change is that it is a difference between two
// totals, and the tempting wrong second total is the one already in hand: the
// CURRENT value. Difference a portfolio against itself and you get $0.00 every
// day, forever, and it looks like a working feature. So the load-bearing test
// here is the MUTATION: `mutantPreviousClose` below is that exact wrong
// implementation, and the suite asserts it produces a different answer on the
// same fixture. If a future refactor makes the real function agree with the
// mutant, the mutation test goes red rather than the feature going quietly
// flat.
//
// The other invariants pinned:
//   • the boundary is the most recent UTC midnight, and a point AT the
//     boundary is not "before" it;
//   • a holding with no prior point contributes its CURRENT value, so it lands
//     as zero change — never as a phantom gain of its whole worth, and never
//     as a drop to zero;
//   • estimated points are not a prior (they drift as the engine re-anchors —
//     CF-AN-ESTIMATE-DRIFTS-IN-THE-DARK), so a holding whose only history is
//     estimated is EXCLUDED from coverage;
//   • no prior anywhere => null, NOT zero. Zero is a measured flat day.
//   • quantity is applied to the stored point, which is per-unit.

import { describe, expect, it } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import {
  computeDayChange,
  previousCloseBoundary,
  summarizeHoldings,
  type PriceTrailsByHolding,
} from "../src/services/portfolioiq/portfolioStore.service.js";

/** Fixed "now": 2026-09-04 14:00Z, so the boundary is 2026-09-04T00:00Z. */
const NOW = Date.parse("2026-09-04T14:00:00.000Z");
const BOUNDARY = "2026-09-04T00:00:00.000Z";

function holding(over: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    id: "h",
    playerName: "Test",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    fairMarketValue: 150,
    ...over,
  } as PortfolioHolding;
}

/**
 * THE FIXTURE. Four holdings, deliberately covering every branch:
 *   a — prior 100, now 120           -> +20, has prior
 *   b — prior 150, now 180           -> +30, has prior
 *   c — NO trail at all, now 500     -> 0 change, no prior (drags toward flat)
 *   d — only an ESTIMATED prior, 300 -> 0 change, no prior (estimates drift)
 *
 * Headline total = 120 + 180 + 500 + 300 = 1100
 * Previous close = 100 + 150 + 500 + 300 = 1050  ->  +$50 on 2 of 4 holdings.
 *
 * The two moves are deliberately BOTH POSITIVE and of different size. A
 * fixture whose moves cancel to zero could not tell a working day change from
 * the mutant below, which reports zero always.
 */
const items: PortfolioHolding[] = [
  holding({ id: "a", fairMarketValue: 120 }),
  holding({ id: "b", fairMarketValue: 180 }),
  holding({ id: "c", fairMarketValue: 500 }),
  holding({ id: "d", fairMarketValue: 300 }),
];

const trails: PriceTrailsByHolding = {
  // Two points before the boundary: the LATER one is the previous close.
  a: [
    { at: "2026-09-02T10:00:00.000Z", value: 90 },
    { at: "2026-09-03T22:00:00.000Z", value: 100 },
    // A point from TODAY — after the boundary. Must be ignored: it is part of
    // today's move, not yesterday's close.
    { at: "2026-09-04T09:00:00.000Z", value: 118 },
  ],
  b: [{ at: "2026-09-03T20:00:00.000Z", value: 150 }],
  // c: absent entirely.
  d: [{ at: "2026-09-03T20:00:00.000Z", value: 250, valuationStatus: "estimated" }],
};

/** The wrong implementation this feature must not collapse into: previous
 *  close = the current total. Always $0.00, every day. */
function mutantPreviousClose(hs: PortfolioHolding[]): number {
  return hs.reduce((sum, h) => sum + Number((h as any).fairMarketValue ?? 0), 0);
}

describe("computeDayChange — the previous close comes off stored history", () => {
  it("sums the last point before the boundary; no-prior holdings contribute their current value", () => {
    const r = computeDayChange(items, trails, 1100, NOW);
    // a: 100 (the 22:00 point, not the 10:00 one, not today's 118)
    // b: 150
    // c: 500 (no trail -> current value, zero change)
    // d: 300 (estimated-only -> current value, zero change)
    expect(r.previousCloseValue).toBe(1050);
    expect(r.previousCloseAt).toBe(BOUNDARY);
    expect(r.dayChangeValue).toBe(50); // 1100 - 1050
    // Rounded to 4 dp, the same precision observedPct uses on this object.
    expect(r.dayChangePct).toBe(Math.round((50 / 1050) * 10000) / 10000);
    expect(r.dayChangePct).toBe(0.0476);
  });

  it("MUTATION: using the current value as the prior gives a different answer", () => {
    // This is the failure mode that looks like a working feature. The real
    // function must NOT agree with it.
    const real = computeDayChange(items, trails, 1100, NOW);
    const mutant = mutantPreviousClose(items); // 1100
    expect(mutant).toBe(1100);
    expect(real.previousCloseValue).not.toBe(mutant);
    // And the move it would report is the tell-tale flat zero.
    expect(1100 - mutant).toBe(0);
    expect(real.dayChangeValue).not.toBe(0);
  });

  it("counts coverage: only holdings with a real observed prior", () => {
    const r = computeDayChange(items, trails, 1100, NOW);
    expect(r.dayChangeCoverage).toEqual({ holdingsWithPrior: 2, holdingsTotal: 4 });
  });

  it("an ESTIMATED point is not a prior — it drifts as the engine re-anchors", () => {
    // Holding d alone. Its only history is estimated, so there is no prior at
    // all: null, not a $50 move against the estimate.
    const r = computeDayChange([items[3]], { d: trails.d }, 300, NOW);
    expect(r.previousCloseValue).toBeNull();
    expect(r.dayChangeValue).toBeNull();
    expect(r.dayChangeCoverage).toEqual({ holdingsWithPrior: 0, holdingsTotal: 1 });
  });

  it("no prior anywhere is NULL, never zero — zero is a measured flat day", () => {
    const r = computeDayChange(items, {}, 1100, NOW);
    expect(r.previousCloseValue).toBeNull();
    expect(r.previousCloseAt).toBeNull();
    expect(r.dayChangeValue).toBeNull();
    expect(r.dayChangePct).toBeNull();
    expect(r.dayChangeCoverage).toEqual({ holdingsWithPrior: 0, holdingsTotal: 4 });
  });

  it("a point exactly AT the boundary is today, not yesterday", () => {
    // Strictly-before is the rule. A point stamped at midnight belongs to the
    // new day, so it is not a previous close.
    const r = computeDayChange(
      [holding({ id: "x", fairMarketValue: 120 })],
      { x: [{ at: BOUNDARY, value: 100 }] },
      120,
      NOW,
    );
    expect(r.dayChangeValue).toBeNull();
    expect(r.dayChangeCoverage.holdingsWithPrior).toBe(0);
  });

  it("the stored point is per-unit: quantity scales it, like the current side", () => {
    // qty 3 at FMV 40 -> current total 120. Prior point 30/unit -> 90.
    const r = computeDayChange(
      [holding({ id: "q", quantity: 3, fairMarketValue: 40 })],
      { q: [{ at: "2026-09-03T12:00:00.000Z", value: 30 }] },
      120,
      NOW,
    );
    expect(r.previousCloseValue).toBe(90);
    expect(r.dayChangeValue).toBe(30);
  });

  it("a sold holding is in neither side of the day change", () => {
    const sold = holding({ id: "s", fairMarketValue: 999, cardStatus: "sold" } as any);
    const r = computeDayChange([...items, sold], trails, 1100, NOW);
    expect(r.dayChangeCoverage.holdingsTotal).toBe(4); // not 5
    expect(r.previousCloseValue).toBe(1050); // unchanged by the sold row
  });

  it("a non-positive previous close yields a null percentage, not Infinity", () => {
    const r = computeDayChange(
      [holding({ id: "z", fairMarketValue: 50, totalCostBasis: 0, purchasePrice: 0 })],
      { z: [{ at: "2026-09-03T12:00:00.000Z", value: 0 }] },
      50,
      NOW,
    );
    expect(r.previousCloseValue).toBe(0);
    expect(r.dayChangePct).toBeNull();
    expect(Number.isFinite(r.dayChangeValue as number)).toBe(true);
  });

  it("a malformed point cannot poison the total", () => {
    const r = computeDayChange(
      [holding({ id: "m", fairMarketValue: 120 })],
      { m: [{ at: "2026-09-03T12:00:00.000Z", value: Number.NaN } as any] },
      120,
      NOW,
    );
    // NaN is not a value: no prior, so the field is null rather than NaN.
    expect(r.previousCloseValue).toBeNull();
    expect(r.dayChangeValue).toBeNull();
  });
});

describe("previousCloseBoundary", () => {
  it("is the most recent UTC midnight at or before now", () => {
    expect(previousCloseBoundary(Date.parse("2026-09-04T14:00:00.000Z"))).toBe(BOUNDARY);
    expect(previousCloseBoundary(Date.parse("2026-09-04T00:00:00.000Z"))).toBe(BOUNDARY);
    expect(previousCloseBoundary(Date.parse("2026-09-04T23:59:59.999Z"))).toBe(BOUNDARY);
    expect(previousCloseBoundary(Date.parse("2026-09-05T00:00:00.001Z"))).toBe(
      "2026-09-05T00:00:00.000Z",
    );
  });
});

describe("summarizeHoldings carries the day change", () => {
  it("reports it against the SAME headline total it prints", () => {
    const s = summarizeHoldings(items, trails, NOW);
    // The headline is the observed sum: 120+180+500+300.
    expect(s.displayableTotalValue).toBe(1100);
    expect(s.previousCloseValue).toBe(1050);
    expect(s.dayChangeValue).toBe(50);
    // The invariant a reader of the bar depends on: the two numbers reconcile.
    expect(s.displayableTotalValue - (s.previousCloseValue as number)).toBeCloseTo(
      s.dayChangeValue as number,
      6,
    );
    expect(s.dayChangeCoverage).toEqual({ holdingsWithPrior: 2, holdingsTotal: 4 });
  });

  it("stays backward-compatible: no trails argument means null day change", () => {
    // Every pre-existing caller passes holdings only. They must keep working,
    // and must NOT start reporting a zero day.
    const s = summarizeHoldings(items);
    expect(s.previousCloseValue).toBeNull();
    expect(s.dayChangeValue).toBeNull();
    expect(s.dayChangePct).toBeNull();
    expect(s.dayChangeCoverage.holdingsWithPrior).toBe(0);
    // and the legacy fields are untouched
    expect(s.displayableTotalValue).toBe(1100);
  });
});
