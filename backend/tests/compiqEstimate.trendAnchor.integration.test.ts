/**
 * CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26) — engine→helper
 * integration test, written FIRST per the chain retrospective rule.
 *
 * Runs computeEstimate end-to-end with the exact prod-shape inputs:
 *   - body.parallel = "Blue X-Fractor /150" (raw form, matches the
 *     CF-CH-MODEL-SIGNAL-PARALLEL-INPUT-FIX contract)
 *   - body.purchasePrice (NEW for this CF) → positionSignal
 *   - lastSale.soldDate (NEW for this CF) → trend regression's
 *     projection target
 *   - getCardDetail.setName = "Chrome Prospects Autographs" (plural,
 *     normalizes to singular in the engine)
 *   - getPricing returns ~73 dated base-auto records with a synthetic
 *     UPWARD trend matching the live Hartman shape
 *
 * Asserts the four new behaviors:
 *   1. trendAnchor populated with direction="up", positive slope,
 *      projectedBaseAtSale > allTimeBaseMedian
 *   2. modelExpectation uses the trend-projected anchor (not Build B's
 *      all-time median) — value > Build B's $250 baseline
 *   3. modelSignal.lean still "sell" but deltaPct meaningfully lower
 *      than the pre-CF +72% (the trend has eaten into the premium)
 *   4. forwardProjection populated (R² > 0.15 gate)
 *   5. positionSignal computed when purchasePrice is set, ABSENT
 *      otherwise — confirms the lean DOES NOT depend on cost basis
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.router.js")>();
  return {
    ...actual,
    getCardSalesRouted: vi.fn(),
    getCardSalesRoutedWithProvenance: vi.fn(),
    findCompsRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

vi.mock("../src/services/compiq/cardsight.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.client.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
  };
});

import { getCardSalesRoutedWithProvenance } from "../src/services/compiq/cardsight.router.js";
import { getPricing, getCardDetail } from "../src/services/compiq/cardsight.client.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";

const mockGetCardSalesRoutedWithProvenance = vi.mocked(getCardSalesRoutedWithProvenance);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const BXF_150_PARALLEL_ID = "b83de312-609d-4d58-af41-c8766a81835f";
const BXF_150_CH_ID = "1778542140951x283396404010038530";

function isoDate(d: Date): string {
  return d.toISOString();
}
function daysAgoDate(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}
function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildChSale(price: number, daysOld: number) {
  return {
    price,
    date: isoDateOnly(daysAgoDate(daysOld)),
    grade: "Raw",
    source: "cardhedge" as const,
    sale_type: "Auction",
    title: "Hartman 2026 Bowman Blue X-Fractor /150 Auto CPA-EHA",
    url: null,
  };
}

function buildHartmanDetail() {
  return {
    notFound: false,
    id: HARTMAN_CS_ID,
    name: "Eric Hartman",
    number: "CPA-EHA",
    releaseName: "Bowman",
    setName: "Chrome Prospects Autographs",
    year: 2026,
    parallels: [{ id: BXF_150_PARALLEL_ID, name: "Blue X-Fractor", numberedTo: 150 }],
    attributes: [],
  } as any;
}

/**
 * Build a synthetic base-auto pricing pool with a known upward trend.
 *
 * Default shape (mirrors the live Hartman 2026 CPA pattern):
 *   - 30-day window
 *   - daily slope of +$1.7/day (≈2-3% per day on an $80 base)
 *   - daily price = day_idx × 1.7 + 75 + noise(±3)
 *   - 2-3 sales per day on average → ~70 records total
 */
function buildSyntheticBaseAutoPricing(opts: {
  slope?: number;       // dollars/day
  intercept?: number;   // dollars at day 0
  noise?: number;       // ±range
  perDayMin?: number;
  perDayMax?: number;
  days?: number;
} = {}) {
  const slope = opts.slope ?? 1.7;
  const intercept = opts.intercept ?? 75;
  const noise = opts.noise ?? 3;
  const perDayMin = opts.perDayMin ?? 2;
  const perDayMax = opts.perDayMax ?? 3;
  const days = opts.days ?? 30;

  // Deterministic pseudo-random for reproducibility.
  let seed = 42;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed & 0xffffffff) / 0x100000000;
  };

  const records: any[] = [];
  for (let i = 0; i < days; i++) {
    const dayIdx = days - 1 - i; // i=0 → oldest, i=days-1 → today
    const dayDate = daysAgoDate(dayIdx);
    const dayPriceMid = intercept + slope * i;
    const n = perDayMin + Math.floor(rng() * (perDayMax - perDayMin + 1));
    for (let k = 0; k < n; k++) {
      const price = Math.max(10, Math.round(dayPriceMid + (rng() * 2 - 1) * noise));
      records.push({
        price,
        date: isoDate(dayDate),
        title: "Eric Hartman 2026 Bowman Chrome CPA-EHA Auto",
        parallel_id: null,
      });
    }
  }
  return {
    card: {
      card_id: HARTMAN_CS_ID,
      name: "Eric Hartman",
      set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" },
      number: "CPA-EHA",
    },
    raw: { count: records.length, records },
    graded: [],
    meta: { total_records: records.length, last_sale_date: records[0]?.date ?? null },
  } as any;
}

/** Flat-market pool — no slope, for the dead-band test. */
function buildFlatBaseAutoPricing(days = 30) {
  return buildSyntheticBaseAutoPricing({ slope: 0, intercept: 85, noise: 2, days });
}

/** Thin pool — fewer than min_days_with_sales. */
function buildThinBaseAutoPricing() {
  return buildSyntheticBaseAutoPricing({ days: 6, perDayMin: 1, perDayMax: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// THE INTEGRATION TEST — runs the full engine pipeline
// ============================================================================

describe("computeEstimate end-to-end → trendAnchor + forwardProjection + positionSignal (CF-CH-MODEL-EXPECTATION-TREND-ANCHOR)", () => {
  it("THE PROD-SHAPE CASE: upward base trend → trendAnchor populated, expectation anchored on projection, lean='sell' but deltaPct meaningfully lower than +72%, forwardProjection populated, positionSignal computed", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetCardDetail.mockResolvedValue(buildHartmanDetail());
    mockGetPricing.mockResolvedValue(buildSyntheticBaseAutoPricing());

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
      purchasePrice: 200, // ← NEW: should drive positionSignal
    } as any)) as Record<string, unknown>;

    // ════════════════════════════════════════════════════════════════════
    // PRIMARY assertions — the four new blocks
    // ════════════════════════════════════════════════════════════════════
    expect(result.estimateSource).toBe("cardhedge-last-sale");
    expect(result.fairMarketValue).toBeNull();

    const modelExpectation = result.modelExpectation as any;
    expect(modelExpectation).toBeDefined();
    expect(modelExpectation).not.toBeNull();

    // 1. trendAnchor populated, direction "up", positive slope.
    const trend = modelExpectation.trendAnchor;
    expect(trend).toBeDefined();
    expect(trend).not.toBeNull();
    expect(trend.direction).toBe("up");
    expect(trend.slopePctPerDay).toBeGreaterThan(0.5);
    expect(trend.trendConfidence).toBeGreaterThan(0.15);
    expect(trend.windowDays).toBe(21);
    expect(trend.daysWithSales).toBeGreaterThanOrEqual(10);
    expect(trend.projectedBaseAtSale).toBeGreaterThan(trend.allTimeBaseMedian);
    expect(trend.allTimeBaseMedian).toBeGreaterThan(0);

    // 2. Expectation uses the trend-projected anchor.
    //    Should be > all-time-anchored Build B value (~$84 × 2.974 ≈ $250).
    expect(modelExpectation.value).toBeGreaterThan(280);

    // 3. Signal still "sell" (sale above range), deltaPct lower than +72%.
    const sig = result.modelSignal as any;
    expect(sig.lean).toBe("sell");
    expect(sig.deltaPct).toBeLessThan(60);  // ← lower than the pre-CF +72%
    expect(sig.deltaPct).toBeGreaterThan(0); // still positive

    // 4. forwardProjection populated (R² > 0.15 gate cleared).
    const fwd = modelExpectation.forwardProjection;
    expect(fwd).toBeDefined();
    expect(fwd).not.toBeNull();
    expect(fwd.low).toBeGreaterThan(0);
    expect(fwd.high).toBeGreaterThan(fwd.low);
    expect(fwd.basis).toBe("trend-projection-prediction-interval");
    expect(fwd.confidence).toBe(trend.trendConfidence);

    // 5. positionSignal computed from purchasePrice=$200.
    const pos = modelExpectation.positionSignal;
    expect(pos).toBeDefined();
    expect(pos).not.toBeNull();
    expect(pos.purchasePrice).toBe(200);
    expect(pos.gainVsLastSale).toBe(250); // 450 - 200
    expect(pos.gainPct).toBeCloseTo(125, 0); // (250/200)×100 = 125%
  });

  it("NO purchasePrice → positionSignal absent on response (lean unaffected)", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetCardDetail.mockResolvedValue(buildHartmanDetail());
    mockGetPricing.mockResolvedValue(buildSyntheticBaseAutoPricing());

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
      // no purchasePrice
    } as any)) as Record<string, unknown>;

    const me = result.modelExpectation as any;
    expect(me.positionSignal).toBeUndefined();
    // Lean still computed — independent of cost basis.
    expect((result.modelSignal as any).lean).toBe("sell");
  });

  it("FLAT MARKET: dead-band kicks in → trendAnchor=null, falls back to Build B all-time anchor", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetCardDetail.mockResolvedValue(buildHartmanDetail());
    mockGetPricing.mockResolvedValue(buildFlatBaseAutoPricing());

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    } as any)) as Record<string, unknown>;

    const me = result.modelExpectation as any;
    expect(me.trendAnchor).toBeUndefined();
    expect(me.forwardProjection).toBeUndefined();
    // Still computes an expectation off all-time anchor.
    expect(me.value).toBeGreaterThan(0);
    expect((result.modelSignal as any).lean).toBe("sell");
  });

  it("THIN POOL: < 10 days with sales → trendAnchor=null, falls back to all-time anchor", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(450, 7)],
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetCardDetail.mockResolvedValue(buildHartmanDetail());
    mockGetPricing.mockResolvedValue(buildThinBaseAutoPricing());

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    } as any)) as Record<string, unknown>;

    const me = result.modelExpectation as any;
    expect(me.trendAnchor).toBeUndefined();
    expect(me.forwardProjection).toBeUndefined();
  });

  it("DOWN TREND: synthetic negative slope → trendAnchor direction='down', expectation REDUCED", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: [buildChSale(200, 7)], // smaller sale, the test is about direction
      chCardId: BXF_150_CH_ID,
      chTrustReason: "prices_by_card_honest",
    });
    mockGetCardDetail.mockResolvedValue(buildHartmanDetail());
    // Negative slope: start high, end low.
    mockGetPricing.mockResolvedValue(
      buildSyntheticBaseAutoPricing({ slope: -1.5, intercept: 130, noise: 2 }),
    );

    const result = (await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman",
      parallel: "Blue X-Fractor /150",
      parallelId: BXF_150_PARALLEL_ID,
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    } as any)) as Record<string, unknown>;

    const me = result.modelExpectation as any;
    expect(me.trendAnchor).not.toBeNull();
    expect(me.trendAnchor.direction).toBe("down");
    expect(me.trendAnchor.slopePctPerDay).toBeLessThan(0);
    expect(me.trendAnchor.projectedBaseAtSale).toBeLessThan(me.trendAnchor.allTimeBaseMedian);
  });
});
