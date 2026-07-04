/**
 * CF-CH-P8-TESTS — END-TO-END through the REAL router seam.
 *
 * Unlike compiqEstimate.chPrimary.test.ts (which mocks at the router
 * boundary), this suite mocks ONLY the vendor HTTP boundary:
 *   - identifyCard + getTrustedComps from cardhedge.client (CH HTTP)
 *   - getPricing + getCardDetail + searchCatalog from cardsight.client (CS HTTP)
 *   - resolveCardId from cardsight.mapper (text resolution)
 *
 * The router (cardsight.router.ts) executes for real: bridge cache,
 * trust-guard decisions, confidence floor, vendor selection. The engine
 * (compiqEstimate.service.ts) runs for real: identity hint construction,
 * pinned-id CH path, divergence telemetry, response-shape construction.
 * Corpus mapping (corpusMapping.ts) runs for real: chProvenance assembly.
 *
 * This is the first place in the chain where every layer is exercised
 * together. If Part A's provenance wiring broke the additive invariant,
 * the CS end-to-end test fails. If chProvenance is mis-wired anywhere
 * between getTrustedComps and the corpus row, the CH end-to-end test fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardhedge.client.js")>();
  return {
    ...actual,
    // Mock only the vendor-HTTP boundary. The router's tryCardHedgeForCs
    // + bridgeCsToCh helpers + the trust-guard + getCardSalesRoutedWithProvenance
    // all execute for real.
    identifyCard: vi.fn(),
    getTrustedComps: vi.fn(),
  };
});

vi.mock("../src/services/compiq/catalogSource.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/catalogSource.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
    resolveCardId: vi.fn(),
  };
});

vi.mock(import("../src/services/shared/cache.service.js"), async (importOriginal) => {
  // Pass-through cacheWrap so the router's 24h bridge cache doesn't memoize
  // across tests and so trust-guard fetches re-execute per case. Other
  // exports (cacheStatsContext etc.) come from the real module.
  const actual = await importOriginal();
  return {
    ...actual,
    cacheWrap: async (_key: string, fn: () => Promise<unknown>) => fn(),
  };
});

import { identifyCard, getTrustedComps } from "../src/services/compiq/cardhedge.client.js";
import { getPricing, getCardDetail, resolveCardId } from "../src/services/compiq/catalogSource.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";
import { corpusEntryFromPricingResult } from "../src/services/corpus/corpusMapping.js";

const mockIdentifyCard = vi.mocked(identifyCard);
const mockGetTrustedComps = vi.mocked(getTrustedComps);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);
const mockResolveCardId = vi.mocked(resolveCardId);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const HARTMAN_CH_ID = "1778542093014x623522278065749040";

function buildCsPricing(records: Array<{ price: number; date: string; title?: string }>) {
  return {
    card: {
      card_id: HARTMAN_CS_ID,
      name: "Eric Hartman",
      set: { release: "Bowman", name: "Chrome Prospects Autographs", year: "2026" },
      number: "CPA-EHA",
    },
    raw: { count: records.length, records: records.map(r => ({ price: r.price, date: r.date, title: r.title ?? "raw", parallel_id: null })) },
    graded: [],
    meta: { total_records: records.length, last_sale_date: records[records.length - 1]?.date ?? null },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCardDetail.mockResolvedValue({ notFound: false, releaseName: "Bowman", year: "2026", parallels: [] } as any);
  mockResolveCardId.mockResolvedValue({
    cardId: HARTMAN_CS_ID,
    parallelId: null,
    matchConfidence: "exact",
    warnings: [],
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// END-TO-END CASE A — identity → router → CardHedge-trusted → estimate → corpus
// ============================================================================

describe("CF-CH-P8-TESTS END-TO-END — CardHedge wins through the REAL seam", () => {
  it("Hartman /99: identifyCard high-confidence + getTrustedComps trusted → estimate carries CH attribution + corpus row has chProvenance", async () => {
    // Vendor HTTP boundary mocks — router + engine + corpus run for real.
    mockIdentifyCard.mockResolvedValue({
      card_id: HARTMAN_CH_ID,
      confidence: 0.97,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true,
      reason: "prices_by_card_honest",
      comps: [
        { price: 240, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Best Offer", title: "Hartman Green Shimmer /99", url: null },
        { price: 250, date: "2026-06-22", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman Green Shimmer /99", url: null },
        { price: 245, date: "2026-06-20", grade: "Raw", source: "card_hedge", sale_type: "Best Offer", title: "Hartman Green Shimmer /99", url: null },
        { price: 260, date: "2026-06-18", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman Green Shimmer /99", url: null },
      ],
      median: 247.5,
      count: 4,
      newestDate: "2026-06-24",
      pricesByCardLength: 7,
    } as any);
    // Cardsight pricing is called in the background by the divergence
    // telemetry — return a healthy CS pool so divergence can compute.
    mockGetPricing.mockResolvedValue(buildCsPricing(
      Array.from({ length: 6 }, (_, i) => ({ price: 240 + i, date: `2026-06-${20 + i}` })),
    ));

    const result = await computeEstimate({
      cardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor /99",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Engine-level: CH attribution all the way through.
    expect(result.estimateSource).toBe("live-market");
    expect(typeof result.fairMarketValue).toBe("number");
    expect(result.chCardId).toBe(HARTMAN_CH_ID);
    expect(result.chTrustReason).toBe("prices_by_card_honest");

    // Real router executed: identifyCard called with a built query that
    // included the player name (the bridge constructs the query).
    expect(mockIdentifyCard).toHaveBeenCalled();
    expect(mockIdentifyCard.mock.calls[0][0].toLowerCase()).toContain("hartman");
    // Real trust-guard call: surname extracted, year passed.
    expect(mockGetTrustedComps).toHaveBeenCalledWith(
      HARTMAN_CH_ID,
      expect.objectContaining({ playerSurname: "hartman", expectedYear: "2026" }),
      "Raw",
    );

    // Corpus row: real corpusEntryFromPricingResult runs against the engine response.
    // chProvenance should carry vendor + chCardId + trustReason.
    const corpusRow = corpusEntryFromPricingResult({
      query: HARTMAN_CS_ID,
      querySource: "card_id",
      endpoint: "/api/compiq/price-by-id",
      durationMs: 312,
      result: result as any,
    });

    expect(corpusRow.response.chProvenance).toBeDefined();
    expect(corpusRow.response.chProvenance).toEqual({
      vendor: "cardhedge",
      chCardId: HARTMAN_CH_ID,
      trustReason: "prices_by_card_honest",
      compCount: 4,
    });
  });
});

// ============================================================================
// END-TO-END CASE B — CardHedge blob → Cardsight floor → no chProvenance
// ============================================================================

describe("CF-CH-P8-TESTS END-TO-END — CardHedge blob → Cardsight floor through the REAL seam", () => {
  it("trust-guard rejects CH (blob_signature) → engine falls to Cardsight floor → estimateSource != cardhedge → corpus row OMITS chProvenance", async () => {
    mockIdentifyCard.mockResolvedValue({
      card_id: HARTMAN_CH_ID,
      confidence: 0.98,
    } as any);
    // Trust-guard rejects the comps — blob signature.
    mockGetTrustedComps.mockResolvedValue({
      trusted: false,
      reason: "blob_signature",
      comps: [],
      median: null,
      count: 0,
      newestDate: null,
      pricesByCardLength: 0,
    } as any);
    // Cardsight floor: healthy 8 comps.
    mockGetPricing.mockResolvedValue(buildCsPricing(
      Array.from({ length: 8 }, (_, i) => ({ price: 80 + i, date: `2026-06-${15 + i}` })),
    ));

    const result = await computeEstimate({
      cardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Floor invariant: CH attribution must NOT appear.
    expect(result.estimateSource).not.toBe("live-market");
    expect(result.chCardId).toBeUndefined();
    expect(result.chTrustReason).toBeUndefined();

    // Real seam confirmed: both CH boundary calls happened.
    expect(mockIdentifyCard).toHaveBeenCalled();
    expect(mockGetTrustedComps).toHaveBeenCalled();

    // Corpus row: chProvenance must be OMITTED entirely (not null) so the
    // CS-row JSON stays byte-identical to pre-P6.
    const corpusRow = corpusEntryFromPricingResult({
      query: HARTMAN_CS_ID,
      querySource: "card_id",
      endpoint: "/api/compiq/price-by-id",
      durationMs: 240,
      result: result as any,
    });

    expect("chProvenance" in corpusRow.response).toBe(false);
  });

  it("identifyCard low confidence (<0.80) → bridge skipped → Cardsight floor → no chProvenance on corpus row", async () => {
    mockIdentifyCard.mockResolvedValue({
      card_id: HARTMAN_CH_ID,
      confidence: 0.70,  // below the MIN_BRIDGE_CONFIDENCE floor in the router
    } as any);
    mockGetPricing.mockResolvedValue(buildCsPricing(
      Array.from({ length: 6 }, (_, i) => ({ price: 90 + i, date: `2026-06-${15 + i}` })),
    ));

    const result = await computeEstimate({
      cardId: HARTMAN_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    expect(result.estimateSource).not.toBe("live-market");
    // Real router: bridge rejected on confidence; getTrustedComps was NEVER called.
    expect(mockIdentifyCard).toHaveBeenCalled();
    expect(mockGetTrustedComps).not.toHaveBeenCalled();

    const corpusRow = corpusEntryFromPricingResult({
      query: HARTMAN_CS_ID,
      querySource: "card_id",
      endpoint: "/api/compiq/price-by-id",
      durationMs: 180,
      result: result as any,
    });
    expect("chProvenance" in corpusRow.response).toBe(false);
  });
});
