/**
 * CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26) — helper unit tests.
 *
 * Pins specific behaviors of computeCardhedgeLastSaleSignal's new
 * trend/forward/position blocks via direct calls to the helper with
 * dependency-injected getCardDetail + getPricing (no engine mock graph).
 *
 * Per the chain retrospective, the INTEGRATION test (engine→helper)
 * lives in compiqEstimate.trendAnchor.integration.test.ts. THESE tests
 * lock helper-internal edge cases the integration test can't drill
 * into directly (env-var tunables, clamp boundaries, dead-band sign,
 * R² gate, positionSignal arithmetic).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCardhedgeLastSaleSignal } from "../src/services/compiq/cardhedgeLastSaleSignal.service.js";

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";

function dateNDaysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

function buildDetail() {
  return {
    notFound: false,
    id: HARTMAN_CS_ID,
    name: "Eric Hartman",
    number: "CPA-EHA",
    releaseName: "Bowman",
    setName: "Chrome Prospects Autographs",
    year: 2026,
    parallels: [],
    attributes: [],
  } as any;
}

/**
 * Build a deterministic pool with a known slope. day 0 = oldest in window.
 */
function buildPool(opts: {
  days?: number;
  perDayMin?: number;
  perDayMax?: number;
  slope?: number;
  intercept?: number;
  noise?: number;
}) {
  const days = opts.days ?? 30;
  const perDayMin = opts.perDayMin ?? 2;
  const perDayMax = opts.perDayMax ?? 3;
  const slope = opts.slope ?? 0;
  const intercept = opts.intercept ?? 85;
  const noise = opts.noise ?? 2;
  let seed = 42;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed & 0xffffffff) / 0x100000000;
  };
  const records: any[] = [];
  for (let i = 0; i < days; i++) {
    const dayIdx = days - 1 - i;
    const dayDate = new Date(Date.now() - dayIdx * 24 * 3600 * 1000);
    const dayPriceMid = intercept + slope * i;
    const n = perDayMin + Math.floor(rng() * (perDayMax - perDayMin + 1));
    for (let k = 0; k < n; k++) {
      records.push({
        price: Math.max(5, Math.round(dayPriceMid + (rng() * 2 - 1) * noise)),
        date: dayDate.toISOString(),
        title: "Eric Hartman 2026 Bowman Chrome CPA-EHA Auto",
        parallel_id: null,
      });
    }
  }
  return {
    card: { card_id: HARTMAN_CS_ID, name: "Eric Hartman", set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" }, number: "CPA-EHA" },
    raw: { count: records.length, records },
    graded: [],
    meta: { total_records: records.length, last_sale_date: records[0]?.date ?? null },
  } as any;
}

beforeEach(() => {
  delete process.env.MODEL_TREND_WINDOW_DAYS;
  delete process.env.MODEL_TREND_DEAD_BAND_PCT;
  delete process.env.MODEL_TREND_MIN_R2;
  delete process.env.MODEL_TREND_MIN_DAYS_WITH_SALES;
  delete process.env.MODEL_TREND_FORWARD_STEP_DAYS;
});

afterEach(() => {
  delete process.env.MODEL_TREND_WINDOW_DAYS;
  delete process.env.MODEL_TREND_DEAD_BAND_PCT;
  delete process.env.MODEL_TREND_MIN_R2;
  delete process.env.MODEL_TREND_MIN_DAYS_WITH_SALES;
  delete process.env.MODEL_TREND_FORWARD_STEP_DAYS;
});

// ============================================================================
// DEAD-BAND
// ============================================================================

describe("trendAnchor — dead-band", () => {
  it("slope barely above dead-band (0.5%/day) → 'up' direction", async () => {
    // Big slope to reliably clear the dead-band. Synthetic = 2%/day.
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.trendAnchor).not.toBeNull();
    expect(result.modelExpectation.trendAnchor!.direction).toBe("up");
  });

  it("slope INSIDE dead-band (≈0% — flat market) → trendAnchor null", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 0, intercept: 85, noise: 1 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.trendAnchor).toBeUndefined();
    expect(result.modelExpectation.forwardProjection).toBeUndefined();
  });

  it("env-tunable dead-band — bigger band → flat triggers more easily", async () => {
    process.env.MODEL_TREND_DEAD_BAND_PCT = "5.0"; // wide band
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        // Synthetic 2%/day — would normally trigger "up" with default 0.5% band.
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    // With band=5.0%, a 2%/day slope reads as flat.
    expect(result.modelExpectation.trendAnchor).toBeUndefined();
  });
});

// ============================================================================
// MIN-DAYS FALLBACK
// ============================================================================

describe("trendAnchor — min-days fallback", () => {
  it("fewer than 10 distinct days with sales → trendAnchor null", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(2),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () =>
          buildPool({ days: 8, perDayMin: 2, perDayMax: 3, slope: 2.0 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.trendAnchor).toBeUndefined();
  });

  it("env-tunable min-days — lower bar lets thinner pools fit", async () => {
    process.env.MODEL_TREND_MIN_DAYS_WITH_SALES = "5";
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(2),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () =>
          buildPool({ days: 8, perDayMin: 2, perDayMax: 3, slope: 2.0 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.trendAnchor).not.toBeNull();
  });
});

// ============================================================================
// DIRECTION SYMMETRY (down trend)
// ============================================================================

describe("trendAnchor — direction symmetry", () => {
  it("synthetic DOWN trend → direction='down', projectedBaseAtSale < allTimeBaseMedian", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 200,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () =>
          buildPool({ slope: -1.5, intercept: 130, noise: 2 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    const trend = result.modelExpectation.trendAnchor;
    expect(trend).not.toBeNull();
    expect(trend!.direction).toBe("down");
    expect(trend!.slopePctPerDay).toBeLessThan(0);
    expect(trend!.projectedBaseAtSale).toBeLessThan(trend!.allTimeBaseMedian);
  });
});

// ============================================================================
// ANTI-PARABOLA CLAMP
// ============================================================================

describe("trendAnchor — anti-parabola clamp", () => {
  it("HOT market: slope so steep that projection would exceed 3.0× anchor → clamped at 3.0× allTimeBaseMedian", async () => {
    // Super-steep slope: starts at $50, ends at $500 over 30 days = +$15/day.
    // Projected to sale date (7 days ago = day 23 of 30) = ~$395.
    // Clamp = 3.0 × allTimeBaseMedian (~ $250-ish median).
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 1500,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () =>
          buildPool({ slope: 15, intercept: 50, noise: 5 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    const trend = result.modelExpectation.trendAnchor;
    expect(trend).not.toBeNull();
    // Clamp ceiling is 3.0 × allTimeBaseMedian.
    expect(trend!.projectedBaseAtSale).toBeLessThanOrEqual(3.0 * trend!.allTimeBaseMedian + 0.01);
  });

  it("CRASHING market: slope so steep down that projection would go below 0.4× → clamped at 0.4× allTimeBaseMedian", async () => {
    // Sharp negative slope.
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 50,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () =>
          buildPool({ slope: -10, intercept: 400, noise: 5 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    const trend = result.modelExpectation.trendAnchor;
    expect(trend).not.toBeNull();
    // Clamp floor is 0.4 × allTimeBaseMedian.
    expect(trend!.projectedBaseAtSale).toBeGreaterThanOrEqual(0.4 * trend!.allTimeBaseMedian - 0.01);
  });
});

// ============================================================================
// R² GATE on forwardProjection
// ============================================================================

describe("forwardProjection — R² gate", () => {
  it("LOW R² (very noisy pool) → trend may still fire but forwardProjection is null", async () => {
    process.env.MODEL_TREND_MIN_R2 = "0.50"; // raise the bar to force gate
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        // High noise drags R² below 0.50.
        getPricing: async () => buildPool({ slope: 1.0, intercept: 85, noise: 40 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    // Forward projection is null because R² < min.
    expect(result.modelExpectation.forwardProjection).toBeUndefined();
  });
});

// ============================================================================
// positionSignal arithmetic
// ============================================================================

describe("positionSignal — arithmetic", () => {
  it("purchasePrice $200, lastSale $450, expectation $300 → gainVsLastSale=$250, gainVsExpectation=$100, gainPct=125%", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
        purchasePrice: 200,
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    const pos = result.modelExpectation.positionSignal;
    expect(pos).not.toBeNull();
    expect(pos!.purchasePrice).toBe(200);
    expect(pos!.gainVsLastSale).toBe(250); // 450 - 200
    expect(pos!.gainPct).toBeCloseTo(125, 0);
    // gainVsExpectation = expectation - purchasePrice
    expect(pos!.gainVsExpectation).toBeCloseTo(
      result.modelExpectation.value - 200,
      1,
    );
  });

  it("missing purchasePrice → positionSignal null", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
        // no purchasePrice
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.positionSignal).toBeUndefined();
  });

  it("zero / negative purchasePrice → positionSignal null (input gate)", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
        purchasePrice: 0,
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result).not.toBeNull();
    if (!result) throw new Error("unreachable");
    expect(result.modelExpectation.positionSignal).toBeUndefined();
  });

  it("positionSignal does NOT affect modelSignal.lean — same lean with or without purchasePrice", async () => {
    const withCost = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
        purchasePrice: 200,
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    const noCost = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(withCost?.modelSignal.lean).toBe(noCost?.modelSignal.lean);
    expect(withCost?.modelSignal.deltaPct).toBe(noCost?.modelSignal.deltaPct);
    expect(withCost?.modelExpectation.value).toBe(noCost?.modelExpectation.value);
  });
});

// ============================================================================
// ENV VARS
// ============================================================================

describe("trend-anchor — env-tunable knobs (defaults preserved)", () => {
  it("MODEL_TREND_WINDOW_DAYS unset → default 21", async () => {
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(7),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result?.modelExpectation.trendAnchor?.windowDays).toBe(21);
  });

  it("MODEL_TREND_WINDOW_DAYS=7 → uses 7-day window (steeper slope reading because narrower data)", async () => {
    process.env.MODEL_TREND_WINDOW_DAYS = "7";
    process.env.MODEL_TREND_MIN_DAYS_WITH_SALES = "5"; // allow fit on 7-day window
    const result = await computeCardhedgeLastSaleSignal(
      {
        cardsightCardId: HARTMAN_CS_ID,
        lastSalePrice: 450,
        product: "Bowman",
        parallelName: "Blue X-Fractor /150",
        year: 2026,
        lastSaleDate: dateNDaysAgo(2),
      },
      {
        getCardDetail: async () => buildDetail(),
        getPricing: async () => buildPool({ slope: 1.7, intercept: 75 }),
      },
    );
    expect(result?.modelExpectation.trendAnchor?.windowDays).toBe(7);
  });
});
