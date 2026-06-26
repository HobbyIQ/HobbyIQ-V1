/**
 * CF-ENGINE-PARALLEL-CANONICALIZE — bridge canonicalizes via Cardsight catalog.
 *
 * The bug it closes (proven against live prod 2026-06-26):
 *   iOS sends a holding row's loose `parallel` string to the CH bridge.
 *   When that string lacks the catalog's variant token ("Green Shimmer"
 *   etc.), CH card-match either lands on the BASE card_id or returns null
 *   — producing wrong-card prices or empty results even though CardHedge
 *   HAS the correct per-parallel card_id with 11 trusted comps.
 *
 * The fix:
 *   When the caller carries a Cardsight parallel UUID alongside the
 *   parent cardId, the router resolves it to `getCardDetail.parallels[]
 *   .find(p => p.id === parallelId)` → `{name} /{numberedTo}` and uses
 *   THAT in the bridge query. The loose iOS string is only consulted
 *   when the id doesn't resolve.
 *
 * The Green Shimmer canonical case: parallelId
 * c1cea15f-5513-43cf-bc32-03d015fe80b1 resolves to "Green Shimmer
 * Refractor /99" — which the prior CF-GREENSHIMMER-ENGINE-TRACE probe
 * confirmed bridges at conf 0.97 to CH id 1778542093014x… with 11
 * trusted comps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  identifyCard: vi.fn(),
  getTrustedComps: vi.fn(),
}));

vi.mock("../src/services/compiq/cardsight.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.client.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
    searchCatalog: vi.fn(),
  };
});

vi.mock(import("../src/services/compiq/cardsight.mapper.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveCardId: vi.fn() };
});

vi.mock("../src/services/compiq/cardsight.translator.js", () => ({
  translateResponse: vi.fn(() => []),
}));

vi.mock("../src/services/shared/cache.service.js", () => ({
  // Pass-through cache so each test sees fresh bridge calls.
  cacheWrap: async (_key: string, fn: () => Promise<unknown>) => fn(),
}));

import { identifyCard, getTrustedComps } from "../src/services/compiq/cardhedge.client.js";
import { getPricing, getCardDetail } from "../src/services/compiq/cardsight.client.js";
import {
  getCardSalesRouted,
  getCardSalesRoutedWithProvenance,
  type CardIdentityHint,
} from "../src/services/compiq/cardsight.router.js";

const mockIdentifyCard = vi.mocked(identifyCard);
const mockGetTrustedComps = vi.mocked(getTrustedComps);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);

// Live-data ids from CF-GREENSHIMMER-ENGINE-TRACE (2026-06-26).
const PARENT_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";
const GREEN_SHIMMER_PARALLEL_ID = "c1cea15f-5513-43cf-bc32-03d015fe80b1";
const GREEN_SHIMMER_CH_ID = "1778542093014x623522278065749040";
const BLUE_REF_PARALLEL_ID = "334908f4-bf5f-4ed5-98c7-75113561ab55";
const BLUE_XF_PARALLEL_ID = "b83de312-609d-4d58-af41-c8766a81835f";

beforeEach(() => {
  vi.clearAllMocks();
  // Default Cardsight floor: returns empty (so we don't accidentally fall
  // through to CS in the assertions below).
  mockGetPricing.mockResolvedValue({
    card: { card_id: PARENT_CS_ID, name: "Eric Hartman" },
    raw: { count: 0, records: [] },
    graded: [],
    meta: { total_records: 0, last_sale_date: null },
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// CASE 1 — the canonical case: parallelId resolves → bridge succeeds where
// iOS's loose string would have failed
// ============================================================================

describe("CF-ENGINE-PARALLEL-CANONICALIZE — canonical case (Green Shimmer)", () => {
  it("parallelId c1cea15f… → bridge query contains 'Green Shimmer Refractor /99' → resolves CH 1778542093014x…", async () => {
    // Cardsight catalog returns the parallel detail.
    mockGetCardDetail.mockResolvedValue({
      notFound: false,
      releaseName: "Bowman",
      year: "2026",
      parallels: [
        { id: GREEN_SHIMMER_PARALLEL_ID, name: "Green Shimmer Refractor", numberedTo: 99 },
        { id: BLUE_REF_PARALLEL_ID, name: "Blue Refractor", numberedTo: 150 },
        { id: BLUE_XF_PARALLEL_ID, name: "Blue X-Fractor", numberedTo: 150 },
      ],
    } as any);

    // CH match returns the Green Shimmer card_id at conf 0.97 ONLY for the
    // canonical query (proves the canonicalize ran). Lower-confidence
    // matches for other queries are explicitly NOT registered.
    mockIdentifyCard.mockImplementation(async (query: string) => {
      if (query.includes("Green Shimmer Refractor /99")) {
        return { card_id: GREEN_SHIMMER_CH_ID, confidence: 0.97 } as any;
      }
      return null;
    });

    // Trust-guard accepts (11 records, primary signal passes).
    mockGetTrustedComps.mockResolvedValue({
      trusted: true,
      reason: "prices_by_card_honest",
      comps: [
        { price: 240, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman Green Shimmer /99", url: null },
        { price: 250, date: "2026-06-22", grade: "Raw", source: "card_hedge", sale_type: "Best Offer", title: "Hartman Green Shimmer /99", url: null },
      ],
      median: 245,
      count: 2,
      newestDate: "2026-06-24",
      pricesByCardLength: 7,
    } as any);

    // iOS sends a WEAK parallel string ("/99" — what we see on prod
    // failing). Canonicalize must override it.
    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "/99",  // <- weak iOS string
      parallelId: GREEN_SHIMMER_PARALLEL_ID,  // <- canonicalize source
      number: "CPA-EHA",
      isAuto: true,
    });

    expect(mockGetCardDetail).toHaveBeenCalledWith(PARENT_CS_ID);
    expect(mockIdentifyCard).toHaveBeenCalledWith(
      expect.stringContaining("Green Shimmer Refractor /99"),
    );
    expect(result.chCardId).toBe(GREEN_SHIMMER_CH_ID);
    expect(result.chTrustReason).toBe("prices_by_card_honest");
    expect(result.sales).toHaveLength(2);
    expect(result.sales[0].source).toBe("cardhedge");
  });

  it("CRITICAL — proves the prod bug fix: weak iOS parallel='/99' alone would land on BASE without canonicalize; WITH parallelId it lands on Green Shimmer", async () => {
    mockGetCardDetail.mockResolvedValue({
      notFound: false,
      parallels: [{ id: GREEN_SHIMMER_PARALLEL_ID, name: "Green Shimmer Refractor", numberedTo: 99 }],
    } as any);

    // Simulate the prod-observed CH behavior: bare "/99" routes to a BASE
    // card_id at conf 0.97. Canonicalized "Green Shimmer Refractor /99"
    // routes to the parallel-specific card_id at conf 0.97.
    mockIdentifyCard.mockImplementation(async (query: string) => {
      if (query.includes("Green Shimmer Refractor /99")) {
        return { card_id: GREEN_SHIMMER_CH_ID, confidence: 0.97 } as any;
      }
      if (query.includes("/99") && !query.includes("Shimmer")) {
        return { card_id: "1778542173652x303328120692600800", confidence: 0.97 } as any; // BASE
      }
      return null;
    });
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 250, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman Green Shimmer /99", url: null }],
      median: 250, count: 1, newestDate: "2026-06-24", pricesByCardLength: 7,
    } as any);

    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "/99",
      parallelId: GREEN_SHIMMER_PARALLEL_ID,
      number: "CPA-EHA",
      isAuto: true,
    });

    // Without canonicalize, this would have been the BASE card_id. With
    // canonicalize, it's the Green Shimmer parallel.
    expect(result.chCardId).toBe(GREEN_SHIMMER_CH_ID);
    expect(result.chCardId).not.toBe("1778542173652x303328120692600800");
  });
});

// ============================================================================
// CASE 2 — backward-compat: no parallelId → unchanged behavior
// ============================================================================

describe("CF-ENGINE-PARALLEL-CANONICALIZE — backward-compat: no parallelId", () => {
  it("no parallelId → getCardDetail NOT called, iOS parallel string passes through unchanged", async () => {
    mockIdentifyCard.mockResolvedValue({
      card_id: GREEN_SHIMMER_CH_ID,
      confidence: 0.95,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 250, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman", url: null }],
      median: 250, count: 1, newestDate: "2026-06-24", pricesByCardLength: 5,
    } as any);

    // No parallelId in the identity hint.
    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor",  // iOS-sent string, no UUID
      number: "CPA-EHA",
      isAuto: true,
    });

    expect(mockGetCardDetail).not.toHaveBeenCalled();
    expect(mockIdentifyCard).toHaveBeenCalledWith(
      expect.stringContaining("Green Shimmer Refractor"),
    );
    expect(result.chCardId).toBe(GREEN_SHIMMER_CH_ID);
  });

  it("no identity hint at all (no playerName) → router takes Cardsight floor; getCardDetail NEVER consulted", async () => {
    const sales = await getCardSalesRouted(PARENT_CS_ID, "Raw", 25);
    expect(mockGetCardDetail).not.toHaveBeenCalled();
    expect(mockIdentifyCard).not.toHaveBeenCalled();
    expect(mockGetPricing).toHaveBeenCalledWith(PARENT_CS_ID);
    expect(sales).toEqual([]);
  });
});

// ============================================================================
// CASE 3 — safety fallback: parallelId doesn't resolve → fall back to iOS string
// ============================================================================

describe("CF-ENGINE-PARALLEL-CANONICALIZE — safety fallbacks", () => {
  it("parallelId provided but getCardDetail returns notFound → falls back to iOS-sent parallel string", async () => {
    mockGetCardDetail.mockResolvedValue({ notFound: true } as any);
    mockIdentifyCard.mockResolvedValue({
      card_id: GREEN_SHIMMER_CH_ID,
      confidence: 0.95,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 250, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "fallback", url: null }],
      median: 250, count: 1, newestDate: "2026-06-24", pricesByCardLength: 5,
    } as any);

    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor",  // iOS-sent fallback
      parallelId: GREEN_SHIMMER_PARALLEL_ID,
      number: "CPA-EHA",
      isAuto: true,
    });

    expect(mockGetCardDetail).toHaveBeenCalled();
    expect(mockIdentifyCard).toHaveBeenCalledWith(
      expect.stringContaining("Green Shimmer Refractor"),
    );
    expect(result.chCardId).toBe(GREEN_SHIMMER_CH_ID);
  });

  it("parallelId provided but parallels[] doesn't contain it → falls back to iOS-sent string", async () => {
    mockGetCardDetail.mockResolvedValue({
      notFound: false,
      parallels: [{ id: BLUE_REF_PARALLEL_ID, name: "Blue Refractor", numberedTo: 150 }], // wrong parallel
    } as any);
    mockIdentifyCard.mockResolvedValue({
      card_id: GREEN_SHIMMER_CH_ID, confidence: 0.95,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 250, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "fallback", url: null }],
      median: 250, count: 1, newestDate: "2026-06-24", pricesByCardLength: 5,
    } as any);

    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Mystery Variant",  // iOS-sent string used as fallback
      parallelId: GREEN_SHIMMER_PARALLEL_ID,
      number: "CPA-EHA",
      isAuto: true,
    });

    expect(mockIdentifyCard).toHaveBeenCalledWith(
      expect.stringContaining("Mystery Variant"),
    );
    expect(result.chCardId).toBe(GREEN_SHIMMER_CH_ID);
  });

  it("parallelId provided + getCardDetail throws → falls back to iOS-sent string (never throws)", async () => {
    mockGetCardDetail.mockRejectedValue(new Error("network timeout"));
    mockIdentifyCard.mockResolvedValue({
      card_id: GREEN_SHIMMER_CH_ID, confidence: 0.95,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 250, date: "2026-06-24", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "fallback", url: null }],
      median: 250, count: 1, newestDate: "2026-06-24", pricesByCardLength: 5,
    } as any);

    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor",
      parallelId: GREEN_SHIMMER_PARALLEL_ID,
      number: "CPA-EHA",
      isAuto: true,
    });

    expect(result.chCardId).toBe(GREEN_SHIMMER_CH_ID);
  });
});

// ============================================================================
// CASE 4 — confidence-collision tightening (per the CF note)
// ============================================================================

describe("CF-ENGINE-PARALLEL-CANONICALIZE — collision tightening", () => {
  it("appending /{numberedTo} disambiguates same-name parallels (Blue Refractor /150 auto vs Blue Refractor on a non-auto card)", async () => {
    mockGetCardDetail.mockResolvedValue({
      notFound: false,
      parallels: [
        { id: BLUE_REF_PARALLEL_ID, name: "Blue Refractor", numberedTo: 150 },
      ],
    } as any);

    // Simulate the documented collision: without "/150", the bare
    // "Blue Refractor" + "Hartman" resolves at 0.82 to a non-auto card
    // on a different namespace. With "/150" appended, CH catches the
    // auto namespace (or correctly returns null if Hartman's BluRef /150
    // doesn't exist in CH — which is the current production reality).
    mockIdentifyCard.mockImplementation(async (query: string) => {
      if (query.includes("Blue Refractor /150")) {
        return null; // Hartman's BluRef /150 isn't in CH catalog
      }
      if (query.includes("Blue Refractor") && !query.includes("/150")) {
        // The DANGEROUS collision case from CF-CH-BRIDGE-CONFIDENCE-COLLISION
        return { card_id: "1778476721015x720745817990000000", confidence: 0.82 } as any;
      }
      return null;
    });

    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Blue",  // weak — what iOS might send
      parallelId: BLUE_REF_PARALLEL_ID,
      number: "CPA-EHA",
      isAuto: true,
    });

    // With canonicalize, the query was "...Blue Refractor /150..." which
    // does NOT collide. CH returns null, the Cardsight floor serves.
    expect(mockIdentifyCard).toHaveBeenCalledWith(
      expect.stringContaining("Blue Refractor /150"),
    );
    expect(result.chCardId).toBeUndefined();
  });

  it("parallel with no numberedTo → bare name (no slash suffix)", async () => {
    mockGetCardDetail.mockResolvedValue({
      notFound: false,
      parallels: [{ id: "no-print-run-parallel", name: "Black X-Fractor" /* numberedTo absent */ }],
    } as any);
    mockIdentifyCard.mockResolvedValue({
      card_id: "1778542128010x936351899414998900", confidence: 0.94,
    } as any);
    mockGetTrustedComps.mockResolvedValue({
      trusted: true, reason: "prices_by_card_honest",
      comps: [{ price: 600, date: "2026-06-22", grade: "Raw", source: "card_hedge", sale_type: "Auction", title: "Hartman Black X-Fractor", url: null }],
      median: 600, count: 1, newestDate: "2026-06-22", pricesByCardLength: 3,
    } as any);

    const result = await getCardSalesRoutedWithProvenance(PARENT_CS_ID, "Raw", 25, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "",
      parallelId: "no-print-run-parallel",
      number: "CPA-EHA",
      isAuto: true,
    });

    // Query contains the canonical name but no /N suffix.
    const queries = mockIdentifyCard.mock.calls.map((c) => String(c[0]));
    expect(queries.some((q) => q.includes("Black X-Fractor"))).toBe(true);
    expect(queries.some((q) => /Black X-Fractor\s*\/\d/.test(q))).toBe(false);
    expect(result.chCardId).toBeDefined();
  });
});
