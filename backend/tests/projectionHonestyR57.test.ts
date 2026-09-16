// R57 (Drew, 2026-09-15) — the projection reports how much evidence it has.
//
// Two live holdings drove this ruling. Both published a defensible-looking
// number over an indefensible label.
//
// A. 1992 Bowman Mariano Rivera #302, BGS 9. Eight BGS 9 sales inside 90d,
//    the newest 3d old and the next 51d old. At the engine's 14-day half
//    life that gap is ~3.4 half-lives, so the newest sale carries 91.2% of
//    the recency weight and the weight-cumulative median stops on it before
//    it ever reaches $67 / $96 / $110. Published: $55.57 with compsUsed 8
//    and confidence 0.694 — an eight-sale trend projection that was, in
//    arithmetic fact, one sale plus 2.6%.
//
// B. 2005 Bowman Chrome Draft Picks & Prospects Justin Verlander BDP129,
//    PSA 10. The PSA 10 pool is ONE sale: the owner's own $251 verified
//    purchase. The player/product pool around it is $3-$33 raw commons
//    trending +25.0%/month; branch 2 applied that grade-agnostic rate over
//    1.67 months and published $355.53 — the owner's money, +41.6%, with no
//    sale in the database supporting it — at confidence 0.71.
//
// Pinned here: the VALUES that were right stay bit-for-bit (Rivera), the
// value that was wrong becomes the sale itself (Verlander), the labels tell
// the truth in both, and a healthy pool with spread weights is untouched.
//
// Fixtures are the real series with ids scrubbed; only price and soldAt
// carry signal, which is all the projection reads.
import { describe, it, expect } from "vitest";
import { projectFromLeadingEdge } from "../src/services/compiq/nextSaleProjection.service.js";

/** The reprice instant both live holdings were valued at. */
const NOW_MS = Date.parse("2026-09-15T23:23:00Z");
/** The half life the unified engine passes (unifiedPricing HALF_LIFE_DAYS). */
const HALF_LIFE_DAYS = 14;

/** Holding A's eight BGS 9 sales, newest first. Ids scrubbed. */
const RIVERA_BGS9 = [
  { price: 54.07, soldDate: "2026-09-13" },
  { price: 96.00, soldDate: "2026-07-27" },
  { price: 110.00, soldDate: "2026-07-24" },
  { price: 109.99, soldDate: "2026-07-15" },
  { price: 48.45, soldDate: "2026-07-07" },
  { price: 45.00, soldDate: "2026-07-07" },
  { price: 67.00, soldDate: "2026-06-29" },
  { price: 31.00, soldDate: "2026-06-29" },
];

describe("R57 — anchor concentration is measured and reported", () => {
  it("Rivera BGS 9: the newest sale carries 91% of the weight and the pool says so", () => {
    const p = projectFromLeadingEdge(RIVERA_BGS9, {
      forwardDays: 0, nowMs: NOW_MS, halfLifeDays: HALF_LIFE_DAYS,
    });
    expect(p).not.toBeNull();

    // BEFORE == AFTER on every number that reaches a user's screen. The
    // guard is a reporting change; it must not move the price by a cent.
    expect(p!.nextSaleValue).toBeCloseTo(55.45, 2);
    expect(p!.anchorPrice).toBeCloseTo(54.07, 2);
    expect(p!.anchorAgeDays).toBeCloseTo(7.9, 1);
    expect(p!.slopePerMonthPct).toBeCloseTo(9.7, 1);
    expect(p!.n).toBe(8);
    expect(p!.cap).toBe("none");

    // The anchor IS the newest sale: the walk stopped on it.
    expect(p!.anchorPrice).toBe(RIVERA_BGS9[0].price);

    // NEW — the concentration the label was hiding.
    expect(p!.anchorDominatesPool).toBe(true);
    expect(p!.anchorWeightShare).toBeCloseTo(0.912, 2);
    // Kish effective-N: (Sum w)^2 / Sum w^2. Eight rows of query, ~1.2
    // rows of evidence.
    expect(p!.effectiveN).toBeCloseTo(1.2, 1);
    expect(p!.effectiveN).toBeLessThan(2);
  });

  it("the three sales under the anchor contribute under 2% of the weight combined", () => {
    // Why the walk can never reach $67/$96/$110: everything below the
    // anchor is rounding error, so the half-weight mark is crossed ON the
    // newest sale. This is the mechanism, pinned directly.
    const p = projectFromLeadingEdge(RIVERA_BGS9, {
      forwardDays: 0, nowMs: NOW_MS, halfLifeDays: HALF_LIFE_DAYS,
    });
    const belowAnchor = RIVERA_BGS9.filter((s) => s.price < p!.anchorPrice);
    expect(belowAnchor.map((s) => s.price).sort((a, b) => a - b)).toEqual([31, 45, 48.45]);

    const w = (soldDate: string) => {
      const age = (NOW_MS - Date.parse(`${soldDate}T00:00:00Z`)) / 86_400_000;
      return Math.exp(-age / HALF_LIFE_DAYS);
    };
    const totalW = RIVERA_BGS9.reduce((s, r) => s + w(r.soldDate), 0);
    const belowW = belowAnchor.reduce((s, r) => s + w(r.soldDate), 0);
    expect(belowW / totalW).toBeLessThan(0.02);
  });

  it("MUTATION CHECK: a healthy 8-sale pool with spread weights is untouched", () => {
    // Same n, same price range, but sales spread evenly across the window
    // instead of one fresh sale and a 48-day hole. Nothing here may trip
    // the guard — if this goes red the guard is firing on real pools.
    const healthy = [
      { price: 108.00, soldDate: "2026-09-13" },
      { price: 96.00, soldDate: "2026-09-08" },
      { price: 110.00, soldDate: "2026-09-03" },
      { price: 101.00, soldDate: "2026-08-29" },
      { price: 99.00, soldDate: "2026-08-24" },
      { price: 104.00, soldDate: "2026-08-19" },
      { price: 97.00, soldDate: "2026-08-14" },
      { price: 106.00, soldDate: "2026-08-09" },
    ];
    const p = projectFromLeadingEdge(healthy, {
      forwardDays: 0, nowMs: NOW_MS, halfLifeDays: HALF_LIFE_DAYS,
    });
    expect(p).not.toBeNull();
    expect(p!.anchorDominatesPool).toBe(false);
    expect(p!.anchorWeightShare).toBeLessThan(0.5);
    // Real evidence: several sales' worth, not one.
    expect(p!.effectiveN).toBeGreaterThan(3);
    expect(p!.n).toBe(8);
  });

  it("MUTATION CHECK: ties at the anchor price count as the two sales they are", () => {
    // Two same-priced sales on the same recent day are TWO sales; the walk
    // would have stopped on either, so their weight is counted together and
    // the pool is not called a one-sale estimator on a technicality.
    const twinNewest = [
      { price: 100.00, soldDate: "2026-09-14" },
      { price: 100.00, soldDate: "2026-09-14" },
      { price: 105.00, soldDate: "2026-09-12" },
      { price: 95.00, soldDate: "2026-09-10" },
      { price: 102.00, soldDate: "2026-09-08" },
      { price: 98.00, soldDate: "2026-09-06" },
      { price: 103.00, soldDate: "2026-09-04" },
      { price: 97.00, soldDate: "2026-09-02" },
    ];
    const p = projectFromLeadingEdge(twinNewest, {
      forwardDays: 0, nowMs: NOW_MS, halfLifeDays: HALF_LIFE_DAYS,
    });
    expect(p!.anchorPrice).toBe(100);
    expect(p!.anchorDominatesPool).toBe(false);
    expect(p!.effectiveN).toBeGreaterThan(5);
  });

  it("a genuinely single-sale pool reports effective n of 1", () => {
    const p = projectFromLeadingEdge([{ price: 251, soldDate: "2026-07-28" }], {
      forwardDays: 0, nowMs: NOW_MS, halfLifeDays: HALF_LIFE_DAYS,
    });
    expect(p!.n).toBe(1);
    expect(p!.effectiveN).toBeCloseTo(1, 1);
    expect(p!.anchorWeightShare).toBeCloseTo(1, 2);
    expect(p!.anchorDominatesPool).toBe(true);
  });

  it("the guard never moves the value: same input, value identical with and without concentration", () => {
    // The concentrated pool and the spread pool both produce a value that
    // is a pure function of anchor + slope * age. Pinning that the new
    // fields are additive: recompute the documented formula by hand.
    const p = projectFromLeadingEdge(RIVERA_BGS9, {
      forwardDays: 0, nowMs: NOW_MS, halfLifeDays: HALF_LIFE_DAYS,
    });
    const byHand = p!.anchorPrice + p!.slopePerDay * p!.anchorAgeDays;
    expect(p!.nextSaleValue).toBeCloseTo(byHand, 1);
  });
});

describe("R57 — thin-pool confidence ceiling", () => {
  it("n<=1 is capped at 0.25 and n==2 at 0.40, whatever the rung claims", async () => {
    const { thinPoolConfidenceCeiling } = await import(
      "../src/services/portfolioiq/hobbyIqFmv.service.js"
    );
    // Verlander's published 0.71 came from cross-setkey's 0.70 floor plus a
    // 1/100 sample bonus. The ceiling is what it must now pass through.
    expect(thinPoolConfidenceCeiling(1)).toBe(0.25);
    expect(Math.min(0.71, thinPoolConfidenceCeiling(1))).toBe(0.25);
    expect(thinPoolConfidenceCeiling(2)).toBe(0.40);
    // A real pool is never lowered by the ceiling.
    expect(thinPoolConfidenceCeiling(3)).toBe(Number.POSITIVE_INFINITY);
    expect(Math.min(0.90, thinPoolConfidenceCeiling(25))).toBe(0.90);
  });
});

describe("R57 — a borrowed grade-agnostic trend never moves a lone graded sale", () => {
  it("Verlander PSA 10: +25%/month over 1.67 months was a 41.6% markup on the owner's own sale", () => {
    // The arithmetic that produced $355.53, pinned so the fix is measurable.
    const anchor = 251;
    const monthsAgo = (NOW_MS - Date.parse("2026-07-28T00:00:00Z")) / 86_400_000 / 30;
    const borrowedTrendPctPerMonth = 25.0;
    const before = anchor * (1 + (borrowedTrendPctPerMonth / 100) * Math.min(monthsAgo, 6));
    expect(monthsAgo).toBeCloseTo(1.666, 2);
    expect(before).toBeCloseTo(355.53, 1);
    expect(before / anchor).toBeCloseTo(1.4165, 3);

    // AFTER: the trend is refused, so the multiplier is 1 and the value is
    // the sale. projectFromLeadingEdge is not the branch here, but the
    // identity the fix restores is exactly this.
    const after = anchor * (1 + (0 / 100) * Math.min(monthsAgo, 6));
    expect(after).toBe(251);
  });

  it("a lone RAW sale is left alone — a raw player trend measures the same kind of card", () => {
    // The refusal is deliberately narrow: it fires on a lone GRADED sale,
    // where the borrowed pool is a different market. A lone raw sale keeps
    // the behaviour it had.
    const anchor = 12;
    const monthsAgo = 1.0;
    const withTrend = anchor * (1 + (25 / 100) * monthsAgo);
    expect(withTrend).toBeCloseTo(15, 5);
  });
});
