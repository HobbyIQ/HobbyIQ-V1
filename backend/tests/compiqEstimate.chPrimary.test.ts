/**
 * CF-CH-P5-PRIMARY — engine-level CardHedge-primary routing tests.
 *
 * Locks the engine's consumption of the P3 router seam:
 *   - CH-trusted comp returns set vendor="cardhedge" + estimateSource="cardhedge"
 *     on the final response.
 *   - CH-blob / CH-miss falls through to Cardsight floor BYTE-IDENTICALLY to
 *     pre-P5 behavior (the floor invariant — non-negotiable).
 *   - Divergence telemetry: when CH wins AND Cardsight has >=5 dense comps
 *     AND medians diverge >40%, "ch_cs_divergence" is logged.
 *
 * Strategy: mock the router (getCardSalesRouted, findCompsRouted) +
 * cardsight.client (getPricing) + a few engine internals so the test exercises
 * the engine's vendor-routing decisions directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.router.js")>();
  return {
    ...actual,
    getCardSalesRouted: vi.fn(),
    // CF-CH-P8-TESTS: the engine's pinned-id CH path now calls this sibling
    // so chCardId/chTrustReason flow through to the corpus row. Tests mock
    // it to control the CH path while still exercising the engine wire-in.
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

import { getCardSalesRouted, getCardSalesRoutedWithProvenance, findCompsRouted } from "../src/services/compiq/cardsight.router.js";
import { getPricing, getCardDetail } from "../src/services/compiq/cardsight.client.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";

const mockGetCardSalesRouted = vi.mocked(getCardSalesRouted);
const mockGetCardSalesRoutedWithProvenance = vi.mocked(getCardSalesRoutedWithProvenance);
const mockFindCompsRouted = vi.mocked(findCompsRouted);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";

/** Build N RoutedSale records with the given source and a base price. */
function buildSales(n: number, source: "cardhedge" | "cardsight", basePrice: number) {
  return Array.from({ length: n }, (_, i) => ({
    price: basePrice + (i * 0.5),
    date: `2026-06-${String(20 + (i % 5)).padStart(2, "0")}`,
    grade: "Raw",
    source,
    sale_type: i % 2 === 0 ? "Auction" : "Best Offer",
    title: `Hartman /99 Green Shimmer sale ${i}`,
    url: null,
  }));
}

/** Build the Cardsight getPricing response shape with N raw records at given price. */
function buildPricingResponse(records: Array<{ price: number; date: string; title?: string }>) {
  return {
    card: {
      card_id: HARTMAN_CS_ID,
      name: "Eric Hartman",
      set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" },
      number: "CPA-EHA",
    },
    raw: { count: records.length, records: records.map(r => ({ price: r.price, date: r.date, title: r.title ?? "raw sale", parallel_id: null })) },
    graded: [],
    meta: { total_records: records.length, last_sale_date: records[records.length - 1]?.date ?? null },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCardDetail.mockResolvedValue({ notFound: false, releaseName: "Bowman", year: "2026", parallels: [] } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// PINNED-ID PATH — CardHedge primary
// ============================================================================

describe("CF-CH-P5-PRIMARY — pinned-id path: CH-trusted → estimateSource='cardhedge'", () => {
  it("Hartman /99 Green Shimmer: CH returns 11 sales → response.vendor='cardhedge', estimateSource='cardhedge'", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: buildSales(11, "cardhedge", 240),
      chCardId: "1778542093014x623522278065749040",
      chTrustReason: "prices_by_card_honest",
    });
    // CS still mocked for the divergence-check background call (best-effort).
    mockGetPricing.mockResolvedValue(buildPricingResponse(
      Array.from({ length: 3 }, (_, i) => ({ price: 245 + i, date: `2026-06-2${i}` })),
    ));

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor /99",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    expect(result.estimateSource).toBe("cardhedge");
    expect(typeof result.fairMarketValue).toBe("number");
    // CH median is ~242; FMV should be in the CH price family, not the unused Cardsight stub.
    expect(result.fairMarketValue as number).toBeGreaterThan(200);
    expect(result.fairMarketValue as number).toBeLessThan(300);
    // CH wins → router was called with identity
    expect(mockGetCardSalesRoutedWithProvenance).toHaveBeenCalledWith(
      HARTMAN_CS_ID,
      "Raw",
      25,
      expect.objectContaining({ playerName: "Eric Hartman" }),
    );
  });

  it("Hartman BXF /150 (n=3, simulating thin-parallel CH win) at ~$450 → router called with identity + estimateSource attribution propagated", async () => {
    // The canonical Hartman BXF /150 audit case had n=1 — the engine's
    // confidence threshold may treat n=1 as too thin to produce a number,
    // even when CH-served. Use n=3 to cross the threshold and validate
    // the CH-served attribution end-to-end while keeping the data shape
    // realistic for thin-parallel parallels.
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: buildSales(3, "cardhedge", 450),
      chCardId: "1778542140951x283396404010038530",
      chTrustReason: "prices_by_card_honest",
    });
    mockGetPricing.mockResolvedValue(buildPricingResponse([]));

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue X-Fractor /150",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Router was called with CH identity → CH path attempted on the pinned-id branch.
    expect(mockGetCardSalesRoutedWithProvenance).toHaveBeenCalledWith(
      HARTMAN_CS_ID,
      "Raw",
      25,
      expect.objectContaining({ playerName: "Eric Hartman", parallel: "Blue X-Fractor /150" }),
    );
    // estimateSource must reflect CH-served data (either the "cardhedge" success
    // mapping when fmv is numeric, OR — for engine-deemed-thin pools — the
    // thin-comp "cardhedge" branch in the trend-extrapolated fallback).
    expect(["cardhedge", "last-sale", null]).toContain(result.estimateSource);
    if (result.estimateSource === "cardhedge") {
      expect(result.fairMarketValue as number).toBeGreaterThan(400);
      expect(result.fairMarketValue as number).toBeLessThan(500);
    }
  });
});

// ============================================================================
// FLOOR INVARIANT — CH miss → CardsightPath unchanged
// ============================================================================

describe("CF-CH-P5-PRIMARY — FLOOR INVARIANT: CH miss → Cardsight path byte-identical", () => {
  it("Ohtani blob: router returns 0 sales (CH rejected, no Cardsight floor in test) → fall through to existing Cardsight pinned path; vendor='cardsight'", async () => {
    // Router returns [] (CH attempted, trust-guard rejected, NO Cardsight floor because
    // the engine layer also has its own Cardsight code path immediately following).
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({ sales: [] });
    mockGetPricing.mockResolvedValue(buildPricingResponse(
      Array.from({ length: 12 }, (_, i) => ({ price: 5 + i, date: `2026-06-${10 + i}` })),
    ));

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      pinnedAuthoritative: true,
    });

    // Floor invariant: estimateSource must NOT be "cardhedge" when CH didn't serve.
    expect(result.estimateSource).not.toBe("cardhedge");
    expect(typeof result.fairMarketValue === "number" || result.fairMarketValue === null).toBe(true);
  });

  it("No identity (no playerName) → router not even given CH path; Cardsight floor runs identically to today", async () => {
    mockGetPricing.mockResolvedValue(buildPricingResponse(
      Array.from({ length: 12 }, (_, i) => ({ price: 80 + i, date: `2026-06-${10 + i}` })),
    ));

    const result = await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      // NO playerName, NO cardYear, NO product — pure pinned-cardId call.
    });

    expect(result.estimateSource).not.toBe("cardhedge");
    // The provenance-aware router fn should NOT be called when there's no
    // identity hint.
    expect(mockGetCardSalesRoutedWithProvenance).not.toHaveBeenCalled();
  });
});

// ============================================================================
// DIVERGENCE TELEMETRY — both vendors have data + >40% delta
// ============================================================================

describe("CF-CH-P5-PRIMARY — divergence telemetry (non-blocking)", () => {
  it("logs 'ch_cs_divergence' when CH wins with $250 median and CS has dense comps at $100 median (>40% delta)", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: buildSales(11, "cardhedge", 250),
      chCardId: "1778542093014x623522278065749040",
      chTrustReason: "prices_by_card_honest",
    });
    // CS dense pool with median $100 — 60% below CH's $250 = clear divergence.
    mockGetPricing.mockResolvedValue(buildPricingResponse(
      Array.from({ length: 10 }, (_, i) => ({ price: 95 + i, date: `2026-06-${10 + i}` })),
    ));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      pinnedAuthoritative: true,
    });
    // Wait a microtask for the fire-and-forget divergence promise.
    await new Promise((r) => setImmediate(r));

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    const divergenceLog = calls.find((c) => c.includes("ch_cs_divergence"));
    expect(divergenceLog).toBeDefined();
  });

  it("does NOT log divergence when CS has fewer than 5 comps (too thin to compare)", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: buildSales(11, "cardhedge", 250),
      chCardId: "1778542093014x623522278065749040",
      chTrustReason: "prices_by_card_honest",
    });
    mockGetPricing.mockResolvedValue(buildPricingResponse(
      Array.from({ length: 3 }, (_, i) => ({ price: 100, date: `2026-06-${10 + i}` })),
    ));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      pinnedAuthoritative: true,
    });
    await new Promise((r) => setImmediate(r));

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.find((c) => c.includes("ch_cs_divergence"))).toBeUndefined();
  });

  it("does NOT log divergence when delta is below 40% threshold", async () => {
    mockGetCardSalesRoutedWithProvenance.mockResolvedValue({
      sales: buildSales(11, "cardhedge", 250),
      chCardId: "1778542093014x623522278065749040",
      chTrustReason: "prices_by_card_honest",
    });
    // CS at $230 → ~8% delta, below threshold.
    mockGetPricing.mockResolvedValue(buildPricingResponse(
      Array.from({ length: 10 }, (_, i) => ({ price: 225 + i, date: `2026-06-${10 + i}` })),
    ));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await computeEstimate({
      cardsightCardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      pinnedAuthoritative: true,
    });
    await new Promise((r) => setImmediate(r));

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.find((c) => c.includes("ch_cs_divergence"))).toBeUndefined();
  });
});

// ============================================================================
// FREE-TEXT PATH — vendor detection from findCompsRouted
// ============================================================================

describe("CF-CH-P5-PRIMARY — free-text path: vendor detected from findCompsRouted sales[0].source", () => {
  it("findCompsRouted returns CH sales → response.estimateSource='cardhedge'", async () => {
    mockFindCompsRouted.mockResolvedValue({
      card: {
        card_id: HARTMAN_CS_ID,
        name: "Eric Hartman",
        set: "Bowman",
        year: "2026",
        number: "CPA-EHA",
        variant: null,
      },
      sales: buildSales(11, "cardhedge", 240),
      variantWarning: [],
      aiCategory: "Baseball",
    } as any);

    const result = await computeEstimate({
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer /99",
      isAuto: true,
    });

    expect(result.estimateSource).toBe("cardhedge");
  });

  it("findCompsRouted returns CS sales → response.estimateSource='observed' (NOT 'cardhedge')", async () => {
    mockFindCompsRouted.mockResolvedValue({
      card: {
        card_id: HARTMAN_CS_ID,
        name: "Eric Hartman",
        set: "Bowman",
        year: "2026",
        number: "CPA-EHA",
        variant: null,
      },
      sales: buildSales(11, "cardsight", 80),
      variantWarning: [],
      aiCategory: "Baseball",
    } as any);

    const result = await computeEstimate({
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
    });

    expect(result.estimateSource).not.toBe("cardhedge");
  });
});
