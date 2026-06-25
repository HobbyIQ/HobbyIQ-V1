/**
 * CF-CH-P3-SEAM — cardsight.router vendor-seam test suite.
 *
 * Seam contract: getCardSalesRouted and findCompsRouted try CardHedge first
 * (via getTrustedComps after a card-match id-bridge), fall through to
 * Cardsight on:
 *   - CH bridge no-match
 *   - CH bridge confidence < 0.80
 *   - CH trust-guard rejects (blob_signature / no_real_data)
 *
 * Tests mock the vendor clients at the module boundary to exercise the
 * router's decision logic without hitting the network.
 *
 * Pre-cutover cardsight.router.test.ts was deleted in CF-CARDHEDGE-HARD-CUTOVER
 * along with the mode-toggle code it tested. This file is a fresh suite for the
 * new seam shape; pre-cutover cases (off/shadow/primary/exclusive modes) are
 * not applicable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  identifyCard: vi.fn(),
  getTrustedComps: vi.fn(),
}));

vi.mock("../src/services/compiq/cardsight.client.js", () => {
  class CardsightTimeoutError extends Error {
    constructor(message = "timeout") {
      super(message);
      this.name = "CardsightTimeoutError";
    }
  }
  return {
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
    CardsightTimeoutError,
  };
});

vi.mock(import("../src/services/compiq/cardsight.mapper.js"), async (importOriginal) => {
  // parallelTitleMatch.ts (transitively imported by router) needs the real
  // tokenizeParallel export. Only resolveCardId is mocked.
  const actual = await importOriginal();
  return {
    ...actual,
    resolveCardId: vi.fn(),
  };
});

vi.mock("../src/services/compiq/cardsight.translator.js", () => ({
  translateResponse: vi.fn(),
}));

vi.mock("../src/services/shared/cache.service.js", () => ({
  // Pass-through so the bridge cache doesn't memoize across tests.
  cacheWrap: async (_key: string, fn: () => Promise<unknown>) => fn(),
}));

import { identifyCard, getTrustedComps } from "../src/services/compiq/cardhedge.client.js";
import { resolveCardId } from "../src/services/compiq/cardsight.mapper.js";
import { getPricing, getCardDetail, CardsightTimeoutError } from "../src/services/compiq/cardsight.client.js";
import { translateResponse } from "../src/services/compiq/cardsight.translator.js";
import {
  getCardSalesRouted,
  findCompsRouted,
  type CardIdentityHint,
} from "../src/services/compiq/cardsight.router.js";

const mockIdentifyCard = vi.mocked(identifyCard);
const mockGetTrustedComps = vi.mocked(getTrustedComps);
const mockResolveCardId = vi.mocked(resolveCardId);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);
const mockTranslateResponse = vi.mocked(translateResponse);

const HARTMAN_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const HARTMAN_CH_ID = "1778542093014x623522278065749040";
const HARTMAN_IDENTITY: CardIdentityHint = {
  playerName: "Eric Hartman",
  cardYear: "2026",
  product: "Bowman Chrome",
  parallel: "Green Shimmer Refractor /99",
  number: "CPA-EHA",
  isAuto: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default Cardsight floor stubs — tests can override.
  mockGetPricing.mockResolvedValue({
    card: { id: HARTMAN_CS_ID, name: "Eric Hartman", set: { release: "Bowman", year: "2026" }, number: "CPA-EHA" },
    raw: { count: 0, records: [] },
    graded: [],
    meta: { total_records: 0, last_sale_date: null },
  } as any);
  mockGetCardDetail.mockResolvedValue({
    notFound: false,
    releaseName: "Bowman",
    year: "2026",
    parallels: [],
  } as any);
  mockResolveCardId.mockResolvedValue({
    cardId: HARTMAN_CS_ID,
    parallelId: null,
    matchConfidence: "exact",
    warnings: [],
  } as any);
  mockTranslateResponse.mockReturnValue([
    { title: "Cardsight comp #1", price: 82, soldDate: "2026-06-20", source: "cardsight" },
  ] as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// SEAM CASE 1 — CardHedge trusted → source="cardhedge"
// ============================================================================

describe("CF-CH-P3-SEAM — CardHedge trusted case", () => {
  it("getCardSalesRouted: CH bridges + trusts → returns CH sales with source='cardhedge'", async () => {
    mockIdentifyCard.mockResolvedValue({
      card_id: HARTMAN_CH_ID,
      confidence: 0.97,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true,
      reason: "prices_by_card_honest",
      comps: [
        { price: 240, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Best Offer", title: "Hartman Green Shimmer /99 - Raw", url: null },
        { price: 250, date: "2026-06-17", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman Green Shimmer /99 - Raw", url: null },
      ],
      median: 245,
      count: 2,
      newestDate: "2026-06-24",
      pricesByCardLength: 7,
    } as any);

    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25, HARTMAN_IDENTITY);

    expect(sales).toHaveLength(2);
    expect(sales[0].source).toBe("cardhedge");
    expect(sales[1].source).toBe("cardhedge");
    expect(mockIdentifyCard).toHaveBeenCalledTimes(1);
    expect(mockGetTrustedComps).toHaveBeenCalledWith(HARTMAN_CH_ID, expect.objectContaining({
      playerSurname: "hartman",
      expectedYear: "2026",
    }), "Raw");
    // Cardsight floor NOT consulted on trusted CH win.
    expect(mockGetPricing).not.toHaveBeenCalled();
  });

  it("findCompsRouted: CH trusted → returns CH sales, CS card-identity metadata preserved", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.97 } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true,
      reason: "prices_by_card_honest",
      comps: [
        { price: 225, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Best Offer", title: "Hartman Purple /250", url: null },
      ],
      median: 225,
      count: 1,
      newestDate: "2026-06-24",
      pricesByCardLength: 10,
    } as any);

    const result = await findCompsRouted("2026 Bowman Chrome Eric Hartman", {
      grade: "Raw",
      queryContext: {
        playerName: "Eric Hartman",
        cardYear: "2026",
        product: "Bowman Chrome",
        parallel: "Purple Refractor /250",
        isAuto: true,
      },
    });

    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].source).toBe("cardhedge");
    expect(result.sales[0].price).toBe(225);
    // CS identity metadata preserved — only sales[] swapped.
    expect(result.card?.card_id).toBe(HARTMAN_CS_ID);
  });
});

// ============================================================================
// SEAM CASE 2 — CardHedge blob → trust rejects → source="cardsight"
// ============================================================================

describe("CF-CH-P3-SEAM — CardHedge blob/miss → Cardsight floor", () => {
  it("getCardSalesRouted: CH bridges but trust-guard rejects (blob_signature) → Cardsight served", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.98 } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: false,
      reason: "blob_signature",
      comps: [],
      median: null,
      count: 0,
      newestDate: null,
      pricesByCardLength: 0,
    } as any);
    mockTranslateResponse.mockReturnValue([
      { title: "Cardsight CS comp #1", price: 85, soldDate: "2026-06-20", source: "cardsight" },
      { title: "Cardsight CS comp #2", price: 78, soldDate: "2026-06-19", source: "cardsight" },
    ] as any);

    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25, HARTMAN_IDENTITY);

    expect(sales).toHaveLength(2);
    expect(sales[0].source).toBe("cardsight");
    expect(sales[1].source).toBe("cardsight");
    expect(mockGetTrustedComps).toHaveBeenCalledTimes(1);
    expect(mockGetPricing).toHaveBeenCalledWith(HARTMAN_CS_ID);
  });

  it("getCardSalesRouted: CH bridges but no_real_data → Cardsight served", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.95 } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: false,
      reason: "no_real_data",
      comps: [],
      median: null,
      count: 0,
      newestDate: null,
      pricesByCardLength: 0,
    } as any);
    mockTranslateResponse.mockReturnValue([
      { title: "CS comp", price: 90, soldDate: "2026-06-20", source: "cardsight" },
    ] as any);

    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25, HARTMAN_IDENTITY);

    expect(sales).toHaveLength(1);
    expect(sales[0].source).toBe("cardsight");
  });
});

// ============================================================================
// SEAM CASE 3 — id-bridge low-confidence → source="cardsight"
// ============================================================================

describe("CF-CH-P3-SEAM — id-bridge low-confidence → Cardsight floor", () => {
  it("getCardSalesRouted: card-match confidence < 0.80 → bridge skipped → Cardsight served", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.65 } as any);
    mockTranslateResponse.mockReturnValue([
      { title: "CS comp at low-confidence path", price: 88, soldDate: "2026-06-20", source: "cardsight" },
    ] as any);

    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25, HARTMAN_IDENTITY);

    expect(sales).toHaveLength(1);
    expect(sales[0].source).toBe("cardsight");
    // getTrustedComps must NOT be called when bridge rejects.
    expect(mockGetTrustedComps).not.toHaveBeenCalled();
  });

  it("getCardSalesRouted: card-match returns null → Cardsight served", async () => {
    mockIdentifyCard.mockResolvedValue(null);
    mockTranslateResponse.mockReturnValue([
      { title: "CS comp at no-match path", price: 76, soldDate: "2026-06-20", source: "cardsight" },
    ] as any);

    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25, HARTMAN_IDENTITY);

    expect(sales).toHaveLength(1);
    expect(sales[0].source).toBe("cardsight");
    expect(mockGetTrustedComps).not.toHaveBeenCalled();
  });
});

// ============================================================================
// BACKWARD-COMPAT: identity NOT provided → pure Cardsight (floor invariant for P3)
// ============================================================================

describe("CF-CH-P3-SEAM — no identity → byte-identical to pre-P3 Cardsight-only behavior", () => {
  it("getCardSalesRouted (no identity): never calls CH, always Cardsight", async () => {
    mockTranslateResponse.mockReturnValue([
      { title: "Pure CS comp", price: 82, soldDate: "2026-06-20", source: "cardsight" },
    ] as any);

    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25);

    expect(sales).toHaveLength(1);
    expect(sales[0].source).toBe("cardsight");
    expect(mockIdentifyCard).not.toHaveBeenCalled();
    expect(mockGetTrustedComps).not.toHaveBeenCalled();
    expect(mockGetPricing).toHaveBeenCalledWith(HARTMAN_CS_ID);
  });

  it("getCardSalesRouted (identity without playerName): bridge skipped, Cardsight served", async () => {
    mockTranslateResponse.mockReturnValue([
      { title: "Pure CS comp", price: 82, soldDate: "2026-06-20", source: "cardsight" },
    ] as any);

    const noPlayerIdentity = { ...HARTMAN_IDENTITY, playerName: "" };
    const sales = await getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25, noPlayerIdentity);

    expect(sales[0].source).toBe("cardsight");
    expect(mockIdentifyCard).not.toHaveBeenCalled();
  });

  it("findCompsRouted (no queryContext.playerName): bridge skipped, pure CS path", async () => {
    const result = await findCompsRouted("ad-hoc query", { grade: "Raw" });
    expect(result.sales[0]?.source).toBe("cardsight");
    expect(mockIdentifyCard).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Surname extraction for trust-guard (Acuna Jr edge case)
// ============================================================================

describe("CF-CH-P3-SEAM — surname extraction for trust-guard", () => {
  it("strips generational suffix: 'Ronald Acuna Jr' → surname 'acuna'", async () => {
    mockIdentifyCard.mockResolvedValue({ card_id: HARTMAN_CH_ID, confidence: 0.97 } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 10, date: "2026-06-20", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Acuna sale", url: null }],
      median: 10, count: 1, newestDate: "2026-06-20", pricesByCardLength: 5,
    } as any);

    const acunaIdentity: CardIdentityHint = { playerName: "Ronald Acuna Jr", cardYear: "2018" };
    await getCardSalesRouted("any-cs-id", "Raw", 25, acunaIdentity);

    expect(mockGetTrustedComps).toHaveBeenCalledWith(
      HARTMAN_CH_ID,
      expect.objectContaining({ playerSurname: "acuna", expectedYear: "2018" }),
      "Raw",
    );
  });
});

// ============================================================================
// Error propagation: Cardsight timeout still throws (existing contract)
// ============================================================================

describe("CF-CH-P3-SEAM — error propagation contract preserved", () => {
  it("CardsightTimeoutError from getPricing propagates as before", async () => {
    mockGetPricing.mockRejectedValue(new CardsightTimeoutError("timeout"));
    await expect(getCardSalesRouted(HARTMAN_CS_ID, "Raw", 25)).rejects.toThrow("timeout");
  });
});
