/**
 * /api/compiq/price-by-id pinned-cardsightCardId path coverage.
 *
 * Post-CF-PRICE-BY-ID-MIGRATION (5640084): fetchComps's pinned-id branch
 * calls cardsight.client.getPricing(cardsightCardId) directly, transforms
 * the raw + graded company/grade tree into RawComp[] via the new
 * selectSalesByGrade helper, and lets the rest of computeEstimate
 * (TrendIQ + prediction layer + FMV) run over Cardsight-sourced comps.
 *
 * Post-CF-CARDHEDGE-HARD-CUTOVER: the meaningful-query fall-through path
 * (Test 2) now also routes through cardsight.router.findCompsRouted -- no
 * CardHedge fallback exists. RoutedResult shape preserved verbatim, so
 * the test's mock fixture port mechanically.
 *
 * Tests:
 *  1. Pinned-id branch (query === cardsightCardId): cardsight.getPricing
 *     called, comps preserved (player-identity guard bypassed via the
 *     existing !body.cardsightCardId short-circuit).
 *  2. Meaningful-query fall-through: when query !== cardsightCardId,
 *     fetchComps falls through to findCompsRouted (Cardsight-only post-
 *     hard-cutover). The pinned-id branch is NOT taken.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mock cardsight.client for the pinned-id branch (CF-PRICE-BY-ID-MIGRATION).
vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    // Pinned-id branch calls getPricing for the cardsightCardId.
    getPricing: vi.fn(),
  };
});

// Mock cardsight.router for the meaningful-query fall-through. Post-
// CF-CARDHEDGE-HARD-CUTOVER, this replaces the prior cardhedge.client mock.
// RoutedResult shape (card/sales/variantWarning/aiCategory) ported verbatim.
vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardSight from "../src/services/compiq/cardsight.client.js";
import * as cardsightRouter from "../src/services/compiq/cardsight.router.js";

describe("computeEstimate — pinned cardsightCardId path (CF-PRICE-BY-ID-MIGRATION)", () => {
  const PINNED_ID = "6134bc63-1a2b-4c3d-9e0f-aabbccddeeff";
  const REAL_QUERY = "2024 Topps Chrome Paul Skenes";

  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: build a CardsightPricingResponse with N fresh raw records.
  function makeFreshPricingResponse() {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const records = Array.from({ length: 12 }, (_, i) => ({
      title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
      price: 40 + i,
      date: isoDaysAgo(i % 5),
      source: "ebay",
      url: null,
    }));
    return {
      card: {
        id: PINNED_ID,
        name: "Paul Skenes",
        number: "USC150",
        releaseName: "Topps Chrome Update",
        setName: "Topps Chrome Update",
        year: 2024,
        player: "Paul Skenes",
      },
      raw: { count: records.length, records },
      graded: [],
      meta: { total_records: records.length, last_sale_date: records[0].date },
    };
  }

  it("pinned-id branch: cardsight.getPricing called when cardsightCardId is set + query equals pinned id", async () => {
    // Force the pinned-id branch by making query === cardsightCardId
    // (iOS resolvedLabel worst-case fallback).
    const QUERY_EQUALS_PINNED = PINNED_ID;

    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFreshPricingResponse(),
    );

    const result = (await computeEstimate({
      playerName: QUERY_EQUALS_PINNED,
      cardsightCardId: PINNED_ID,
    } as any, testCallContext)) as Record<string, unknown>;

    // Primary assertion: the player-identity guard must NOT wipe the
    // pinned comps (the !body.cardsightCardId short-circuit holds).
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // The pinned-id branch called Cardsight getPricing with the pinned UUID.
    expect(cardSight.getPricing).toHaveBeenCalledWith(PINNED_ID);

    // Post-CF-CARDHEDGE-HARD-CUTOVER: confirm the routed Cardsight path
    // (findCompsRouted) was NOT called for the pinned-id case -- the
    // pinned-id branch should short-circuit before reaching the router.
    expect(cardsightRouter.findCompsRouted).not.toHaveBeenCalled();
    expect(cardsightRouter.searchCardsRouted).not.toHaveBeenCalled();

    // Sanity: variantWarning must NOT contain "player_mismatch".
    const variantWarning = (result.variantWarning as string[] | undefined) ?? [];
    expect(variantWarning).not.toContain("player_mismatch");
  });

  it("meaningful-query fall-through: bypasses pinned-id branch when query !== cardsightCardId", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const sales = Array.from({ length: 12 }, (_, i) => ({
      price: 40 + i,
      date: isoDaysAgo(i % 5),
      grade: "Raw",
      source: "cardsight",
      sale_type: null,
      title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
      url: null,
    }));
    // Post-CF-CARDHEDGE-HARD-CUTOVER: meaningful-query fall-through routes
    // through cardsight.router.findCompsRouted (Cardsight-only). The
    // RoutedResult shape is preserved -- this mock fixture matches what
    // the prior cardhedge.client findCompsByQuery mock provided verbatim.
    (cardsightRouter.findCompsRouted as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        card_id: PINNED_ID,
        title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
        player: "Paul Skenes",
        set: "2024 Topps Chrome Update",
        year: 2024,
        number: "USC150",
        variant: "Base",
      },
      sales,
      variantWarning: [],
      aiCategory: null,
    });

    const result = (await computeEstimate({
      playerName: REAL_QUERY, // meaningful query, different from PINNED_ID
      cardsightCardId: PINNED_ID,
    } as any, testCallContext)) as Record<string, unknown>;

    // The fall-through path must surface comps.
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // The fall-through path must call findCompsRouted.
    expect(cardsightRouter.findCompsRouted).toHaveBeenCalled();

    // The pinned-id branch (Cardsight getPricing) must NOT be taken.
    expect(cardSight.getPricing).not.toHaveBeenCalled();
  });
});
