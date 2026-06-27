/**
 * CF-CARDSIGHT-REMOVAL (Phase 3 Wave 3b) — pinned-id path decommission lock.
 *
 * Backfill coverage replacing the retired Cardsight-coupled pinned-id tests
 * (compiqEstimatePinnedCard, compiqEstimate.pinnedAuthoritative). Those
 * asserted the now-deleted `cardsight.client.getPricing(cardsightCardId)`
 * branch. That branch is GONE: CardHedge (via the router seam) is the sole
 * comp source, and on a CardHedge miss the engine returns ZERO comps for the
 * pinned card rather than falling back to a Cardsight pricing call.
 *
 * These tests lock the post-removal reality:
 *   1. Pinned-id + CardHedge serves   → estimateSource="cardhedge".
 *   2. Pinned-id + CardHedge miss      → NOT "cardhedge", no Cardsight fallback.
 *   3. Pinned-id with no identity hint → router provenance fn never called.
 *   4. DECOMMISSION INVARIANT (all paths): the engine never calls catalogSource
 *      getPricing / getCardDetail. This is the regression guard for the whole
 *      Cardsight-removal arc — if anyone re-wires a Cardsight pricing call into
 *      the pinned-id branch, these spies trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.router.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/compiq/cardsight.router.js")>();
  return {
    ...actual,
    getCardSalesRouted: vi.fn(),
    getCardSalesRoutedWithProvenance: vi.fn(),
    findCompsRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

// Spy on the catalog seam. The engine no longer imports getPricing /
// getCardDetail (compiqEstimate.service.ts imports only the CardsightSaleRecord
// type from catalogSource), so these must NEVER be called from any pinned-id
// path. Mocking them lets us assert that invariant directly.
vi.mock("../src/services/compiq/catalogSource.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/compiq/catalogSource.js")>();
  return {
    ...actual,
    getPricing: vi.fn(),
    getCardDetail: vi.fn(),
  };
});

// CF-CARDSIGHT-REMOVAL (Wave 3): the trendIQ L3 broader-pool trend path calls
// fetchCompsByPlayer (live HTTP to the comps-by-player seam). Stub it to
// resolve instantly-empty so these tests don't incur un-mocked network latency.
// Empty comps keeps trendIQ "insufficient" — identical to the live fallback
// shape — so the pinned-path attributions under test are unaffected.
vi.mock("../src/services/compiq/compsByPlayer.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCompsByPlayer: vi.fn(
      async (input: { playerName: string; product: string; cardYear?: number }) => ({
        player: input.playerName,
        product: input.product,
        ...(input.cardYear !== undefined ? { cardYear: input.cardYear } : {}),
        cardIds: [],
        comps: [],
        cached: false,
        warnings: [],
      }),
    ),
  };
});

import {
  getCardSalesRoutedWithProvenance,
  findCompsRouted,
} from "../src/services/compiq/cardsight.router.js";
import {
  getPricing,
  getCardDetail,
} from "../src/services/compiq/catalogSource.js";
import { computeEstimate } from "../src/services/compiq/compiqEstimate.service.js";

const mockProvenance = vi.mocked(getCardSalesRoutedWithProvenance);
const mockFindCompsRouted = vi.mocked(findCompsRouted);
const mockGetPricing = vi.mocked(getPricing);
const mockGetCardDetail = vi.mocked(getCardDetail);

const PINNED_CS_ID = "befe9bcc-e7e8-458c-9cd8-ce831848b9a1";

/** Build N CardHedge RoutedSale records at a base price (source="cardhedge"). */
function buildChSales(n: number, basePrice: number) {
  return Array.from({ length: n }, (_, i) => ({
    price: basePrice + i * 0.5,
    date: `2026-06-${String(20 + (i % 5)).padStart(2, "0")}`,
    grade: "Raw",
    source: "cardhedge" as const,
    sale_type: i % 2 === 0 ? "Auction" : "Best Offer",
    title: `Eric Hartman /99 Green Shimmer sale ${i}`,
    url: null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CF-CARDSIGHT-REMOVAL — pinned-id path is CardHedge-only", () => {
  it("CardHedge serves the pinned card → estimateSource='cardhedge', catalog pricing never called", async () => {
    mockProvenance.mockResolvedValue({
      sales: buildChSales(11, 240),
      chCardId: "1778542093014x623522278065749040",
      chTrustReason: "prices_by_card_honest",
    });

    const result = await computeEstimate({
      cardsightCardId: PINNED_CS_ID,
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
    expect(result.fairMarketValue as number).toBeGreaterThan(200);
    expect(result.fairMarketValue as number).toBeLessThan(300);
    // Router was given the identity bridge for the CardHedge attempt.
    expect(mockProvenance).toHaveBeenCalledWith(
      PINNED_CS_ID,
      "Raw",
      25,
      expect.objectContaining({ playerName: "Eric Hartman" }),
    );
    // DECOMMISSION INVARIANT: no Cardsight pricing call from the engine.
    expect(mockGetPricing).not.toHaveBeenCalled();
    expect(mockGetCardDetail).not.toHaveBeenCalled();
  });

  it("CardHedge miss (identity present) → NOT 'cardhedge', no Cardsight fallback fires", async () => {
    // CH attempted via the identity bridge, but returns zero sales. Post-
    // removal the engine returns empty comps for the pinned card — it does
    // NOT fall through to a Cardsight getPricing call.
    mockProvenance.mockResolvedValue({ sales: [] });

    const result = await computeEstimate({
      cardsightCardId: PINNED_CS_ID,
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      pinnedAuthoritative: true,
    });

    // CH path WAS attempted (identity present)...
    expect(mockProvenance).toHaveBeenCalledTimes(1);
    expect(mockProvenance).toHaveBeenCalledWith(
      PINNED_CS_ID,
      "Raw",
      25,
      expect.objectContaining({ playerName: "Shohei Ohtani" }),
    );
    // ...but CH didn't serve, so the result is not CardHedge-attributed.
    expect(result.estimateSource).not.toBe("cardhedge");
    // DECOMMISSION INVARIANT: the removed Cardsight floor must not run.
    expect(mockGetPricing).not.toHaveBeenCalled();
    expect(mockGetCardDetail).not.toHaveBeenCalled();
  });

  it("pinned-id with no identity hint (no playerName) → router provenance fn never called, no Cardsight call", async () => {
    const result = await computeEstimate({
      cardsightCardId: PINNED_CS_ID,
      // No playerName / cardYear / product — nothing to bridge to CardHedge.
    });

    // No identity bridge → CH provenance fn is not even attempted.
    expect(mockProvenance).not.toHaveBeenCalled();
    expect(result.estimateSource).not.toBe("cardhedge");
    // DECOMMISSION INVARIANT.
    expect(mockGetPricing).not.toHaveBeenCalled();
    expect(mockGetCardDetail).not.toHaveBeenCalled();
  });

  it("pinnedAuthoritative=true forces the pinned branch even with a meaningful query (findCompsRouted not used)", async () => {
    mockProvenance.mockResolvedValue({
      sales: buildChSales(11, 240),
      chCardId: "1778542093014x623522278065749040",
      chTrustReason: "prices_by_card_honest",
    });

    const result = await computeEstimate({
      cardsightCardId: PINNED_CS_ID,
      playerName: "Eric Hartman",
      cardYear: 2026,
      product: "Bowman Chrome",
      parallel: "Green Shimmer Refractor /99",
      cardNumber: "CPA-EHA",
      isAuto: true,
      pinnedAuthoritative: true,
    });

    // Pinned branch taken → provenance fn used, free-text router NOT used.
    expect(mockProvenance).toHaveBeenCalledTimes(1);
    expect(mockFindCompsRouted).not.toHaveBeenCalled();
    expect(result.estimateSource).toBe("cardhedge");
    expect(mockGetPricing).not.toHaveBeenCalled();
    expect(mockGetCardDetail).not.toHaveBeenCalled();
  });
});
