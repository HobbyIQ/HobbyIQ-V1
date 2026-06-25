/**
 * CF-TREND-ADJUSTED-PRICING test suite.
 *
 * Covers computeTrendAdjustment + the new TrendAdjustment field on
 * findCompsByQuery's return value. Mocks at the global.fetch boundary so
 * the real cache wrapper + real algorithm run end-to-end. Unique card_ids
 * across tests avoid in-memory cache reuse.
 *
 * Momentum is hard-capped at +/-200% per 30 days (3.0x/0.333x) - anything
 * beyond is treated as a spike rather than a sustainable trend.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { computeTrendAdjustment } from "../src/services/compiq/cardhedge.client";

const PRICES_URL = "https://api.cardhedger.com/v1/cards/prices-by-card";
const SEARCH_URL = "https://api.cardhedger.com/v1/cards/card-search";

beforeAll(() => {
  process.env.CARD_HEDGE_API_KEY = "test-trend-key";
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function installFetchRouter(routes: {
  pricesByCard?: { closing_date: string; price: number | string }[];
  searchCards?: Array<Record<string, unknown>>;
}): { fetchMock: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url === PRICES_URL) {
      return new Response(JSON.stringify({ prices: routes.pricesByCard ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === SEARCH_URL) {
      return new Response(JSON.stringify({ cards: routes.searchCards ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not-found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { fetchMock: fn, calls };
}

describe("computeTrendAdjustment - core algorithm", () => {
  const hartmanBxf = {
    card_id: "ch-bxf-hartman-test-1",
    player: "Eric Hartman",
    set: "2026 Bowman Baseball",
    year: 2026,
    number: "CPA-EHA-TEST-1",
    variant: "Blue X-Fractor",
  };

  const hartmanBxfSale = {
    price: 450,
    date: "2026-06-19",
    grade: "Raw",
    source: "ebay",
    sale_type: "Best Offer",
    title: "2026 Bowman Chrome Eric Hartman Blue X-Fractor Auto 002/150",
    url: null,
  };

  const hartmanBase = {
    card_id: "ch-base-hartman-test-1",
    player: "Eric Hartman",
    set: "2026 Bowman Baseball",
    year: 2026,
    number: "CPA-EHA-TEST-1",
    variant: "Base",
  };

  const baseSeries30d = [
    { closing_date: "2026-05-26", price: 90 },
    { closing_date: "2026-05-27", price: 89.71 },
    { closing_date: "2026-05-28", price: 89 },
    { closing_date: "2026-05-29", price: 78.12 },
    { closing_date: "2026-05-30", price: 95 },
    { closing_date: "2026-05-31", price: 83.59 },
    { closing_date: "2026-06-01", price: 75.91 },
    { closing_date: "2026-06-02", price: 70.57 },
    { closing_date: "2026-06-03", price: 75.13 },
    { closing_date: "2026-06-04", price: 78 },
    { closing_date: "2026-06-05", price: 73.34 },
    { closing_date: "2026-06-06", price: 78.4 },
    { closing_date: "2026-06-07", price: 83.5 },
    { closing_date: "2026-06-08", price: 82.27 },
    { closing_date: "2026-06-09", price: 87.57 },
    { closing_date: "2026-06-10", price: 89.88 },
    { closing_date: "2026-06-11", price: 74.96 },
    { closing_date: "2026-06-12", price: 78.49 },
    { closing_date: "2026-06-13", price: 91.67 },
    { closing_date: "2026-06-14", price: 96.25 },
    { closing_date: "2026-06-15", price: 87.22 },
    { closing_date: "2026-06-16", price: 94.56 },
    { closing_date: "2026-06-17", price: 92.51 },
    { closing_date: "2026-06-18", price: 100.71 },
    { closing_date: "2026-06-19", price: 93.5 },
    { closing_date: "2026-06-20", price: 83.32 },
    { closing_date: "2026-06-21", price: 98.57 },
    { closing_date: "2026-06-22", price: 114.47 },
    { closing_date: "2026-06-23", price: 113.45 },
    { closing_date: "2026-06-24", price: 117.8 },
    { closing_date: "2026-06-25", price: 134 },
  ];

  it("Tier 2: BXF $450 anchor + base series $93.5->$134 with cap firing", async () => {
    installFetchRouter({ pricesByCard: baseSeries30d, searchCards: [hartmanBase] });

    const result = await computeTrendAdjustment(hartmanBxf, [hartmanBxfSale]);

    expect(result).not.toBeNull();
    expect(result!.rawCompPrice).toBe(450);
    expect(result!.rawCompDate).toBe("2026-06-19");
    expect(result!.momentumWasCapped).toBe(true);
    expect(result!.momentum).toBeGreaterThan(1.2);
    expect(result!.momentum).toBeLessThan(1.3);
    expect(result!.trendAdjustedPrice).toBeGreaterThan(540);
    expect(result!.trendAdjustedPrice).toBeLessThan(580);
    expect(result!.basePriceAtCompDate).toBe(93.5);
    expect(result!.basePriceToday).toBe(134);
    expect(result!.daysSinceComp).toBe(6);
    expect(result!.baseCardId).toBe(hartmanBase.card_id);
    expect(result!.confidenceBandLow).toBeCloseTo(result!.trendAdjustedPrice * 0.85, 1);
    expect(result!.confidenceBandHigh).toBeCloseTo(result!.trendAdjustedPrice * 1.15, 1);
  });

  it("Tier 2: flat market -> momentum ~1.0, narrow 8% band", async () => {
    const flatSeries = Array.from({ length: 10 }, (_, i) => ({
      closing_date: `2026-06-${String(i + 15).padStart(2, "0")}`,
      price: 100,
    }));
    // Unique player/year/set so the searchCards cache key differs from the
    // earlier test (same player would return that test's mocked results).
    const flatParallel = {
      card_id: "ch-flat-p",
      player: "Flat Test Player",
      set: "2025 Flat Test Set",
      year: 2025,
      number: "FLAT-1",
      variant: "Blue X-Fractor",
    };
    const flatBase = {
      card_id: "ch-flat-b",
      player: "Flat Test Player",
      set: "2025 Flat Test Set",
      year: 2025,
      number: "FLAT-1",
      variant: "Base",
    };
    installFetchRouter({ pricesByCard: flatSeries, searchCards: [flatBase] });

    const result = await computeTrendAdjustment(flatParallel, [{
      price: 500,
      date: "2026-06-20",
      grade: "Raw",
      source: "ebay",
      sale_type: "Auction",
      title: "test",
      url: null,
    }]);

    expect(result).not.toBeNull();
    expect(result!.momentum).toBe(1);
    expect(result!.momentumWasCapped).toBe(false);
    expect(result!.trendAdjustedPrice).toBe(500);
    expect(result!.confidenceBandLow).toBe(460);
    expect(result!.confidenceBandHigh).toBe(540);
  });
});

describe("computeTrendAdjustment - null-return gates", () => {
  const stubParallel = {
    card_id: "stub-parallel-1",
    player: "Test Player",
    set: "2024 Test Set",
    year: 2024,
    number: "TP-1",
    variant: "Blue Refractor",
  };

  const stubSale = {
    price: 100,
    date: "2026-06-15",
    grade: "Raw",
    source: "ebay",
    sale_type: "Auction",
    title: "Test sale",
    url: null,
  };

  it("returns null when parallelSales is empty", async () => {
    installFetchRouter({});
    expect(await computeTrendAdjustment(stubParallel, [])).toBeNull();
  });

  it("returns null when parallelSales has 3+ sales", async () => {
    installFetchRouter({});
    expect(await computeTrendAdjustment(stubParallel, [stubSale, stubSale, stubSale])).toBeNull();
  });

  it("returns null when the card is the Base variant", async () => {
    installFetchRouter({});
    const baseCard = { ...stubParallel, variant: "Base" };
    expect(await computeTrendAdjustment(baseCard, [stubSale])).toBeNull();
  });

  it("returns null when parallelCard has no card_id", async () => {
    installFetchRouter({});
    const noIdCard = { ...stubParallel, card_id: "" };
    expect(await computeTrendAdjustment(noIdCard, [stubSale])).toBeNull();
  });

  it("returns null when parallelCard is null", async () => {
    installFetchRouter({});
    expect(await computeTrendAdjustment(null, [stubSale])).toBeNull();
  });

  it("returns null when no base sibling found in CH catalog", async () => {
    installFetchRouter({ searchCards: [] });
    const card = { ...stubParallel, card_id: "p-no-base-1", number: "NOBASE-1" };
    expect(await computeTrendAdjustment(card, [stubSale])).toBeNull();
  });

  it("returns null when base sibling has fewer than 7 daily price points", async () => {
    const thinBase = {
      card_id: "thin-base-1",
      player: "Test Player",
      set: "2024 Test Set",
      year: 2024,
      number: "THIN-1",
      variant: "Base",
    };
    installFetchRouter({
      searchCards: [thinBase],
      pricesByCard: [
        { closing_date: "2026-06-20", price: 50 },
        { closing_date: "2026-06-21", price: 51 },
        { closing_date: "2026-06-22", price: 52 },
      ],
    });
    const card = { ...stubParallel, card_id: "thin-parallel-1", number: "THIN-1" };
    expect(await computeTrendAdjustment(card, [stubSale])).toBeNull();
  });
});

describe("computeTrendAdjustment - magnitude cap (+/-200% per 30d)", () => {
  it("clamps explosive momentum to the magnitude cap", async () => {
    const explosiveSeries = Array.from({ length: 14 }, (_, i) => ({
      closing_date: `2026-06-${String(i + 12).padStart(2, "0")}`,
      price: 10 + i * 3,
    }));
    const explosiveBase = {
      card_id: "exp-base-1",
      player: "Welbyn Francisca",
      set: "2026 Bowman Baseball",
      year: 2026,
      number: "EXP-1",
      variant: "Base",
    };
    const explosiveParallel = {
      card_id: "exp-parallel-1",
      player: "Welbyn Francisca",
      set: "2026 Bowman Baseball",
      year: 2026,
      number: "EXP-1",
      variant: "Blue Refractor",
    };
    installFetchRouter({ pricesByCard: explosiveSeries, searchCards: [explosiveBase] });

    const recentSale = {
      price: 50,
      date: "2026-06-12",
      grade: "Raw",
      source: "ebay",
      sale_type: "Auction",
      title: "test",
      url: null,
    };
    const result = await computeTrendAdjustment(explosiveParallel, [recentSale]);

    expect(result).not.toBeNull();
    expect(result!.momentumWasCapped).toBe(true);
    expect(result!.momentum).toBeGreaterThan(1.4);
    expect(result!.momentum).toBeLessThan(2.0);
  });

  it("does NOT cap when momentum is within the per-day window", async () => {
    const gentleSeries = Array.from({ length: 14 }, (_, i) => ({
      closing_date: `2026-06-${String(i + 12).padStart(2, "0")}`,
      price: 100 + i,
    }));
    const gentleBase = {
      card_id: "gentle-base-1",
      player: "Test",
      set: "2024 Test",
      year: 2024,
      number: "GENTLE-1",
      variant: "Base",
    };
    const gentleParallel = {
      card_id: "gentle-parallel-1",
      player: "Test",
      set: "2024 Test",
      year: 2024,
      number: "GENTLE-1",
      variant: "Purple Refractor",
    };
    installFetchRouter({ pricesByCard: gentleSeries, searchCards: [gentleBase] });

    const result = await computeTrendAdjustment(gentleParallel, [{
      price: 200,
      date: "2026-06-15",
      grade: "Raw",
      source: "ebay",
      sale_type: "Auction",
      title: "test",
      url: null,
    }]);

    expect(result).not.toBeNull();
    expect(result!.momentumWasCapped).toBe(false);
    expect(result!.momentum).toBeGreaterThan(1.05);
    expect(result!.momentum).toBeLessThan(1.15);
  });
});
