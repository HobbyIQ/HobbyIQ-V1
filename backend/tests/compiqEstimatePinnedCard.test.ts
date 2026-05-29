/**
 * /api/compiq/price-by-id pinned-cardsightCardId path coverage.
 *
 * Pre-CF-PRICE-BY-ID-MIGRATION: fetchComps's pinned-id branch called
 * cardhedge.client.getCardSales (returned [] under CARDSIGHT_MODE=
 * exclusive — route was effectively broken in production).
 *
 * Post-CF-PRICE-BY-ID-MIGRATION: fetchComps's pinned-id branch calls
 * cardsight.client.getPricing(cardsightCardId) directly, transforms
 * the raw + graded company/grade tree into RawComp[] via the new
 * selectSalesByGrade helper, and lets the rest of computeEstimate
 * (TrendIQ + prediction layer + FMV) run over Cardsight-sourced comps.
 *
 * Tests:
 *  1. Pinned-id branch (query === cardsightCardId): cardsight.getPricing
 *     called, comps preserved (player-identity guard bypassed via the
 *     existing !body.cardsightCardId short-circuit).
 *  2. Meaningful-query fall-through: when query !== cardsightCardId,
 *     fetchComps falls through to findCompsRouted — under
 *     CARDSIGHT_MODE=off (test default) this delegates to
 *     cardhedge.findCompsByQuery; under CARDSIGHT_MODE=exclusive
 *     (production) it routes to Cardsight via resolveCardId+getPricing.
 *     Either way the pinned-id branch is NOT taken.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mock the cardsight client BEFORE importing the service under test.
// vi.mock calls are hoisted; the service picks up the mock when it
// resolves its dependency. The path must match the literal specifier
// used by the source: `./cardsight.client.js` from compiqEstimate.service.ts.
vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    // Pinned-id branch calls getPricing for the cardsightCardId.
    getPricing: vi.fn(),
  };
});

// Also mock the cardhedge client for the meaningful-query fall-through
// test below — under CARDSIGHT_MODE=off (test default) findCompsRouted
// delegates to findCompsByQuery here.
vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  searchCards: vi.fn(),
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardSight from "../src/services/compiq/cardsight.client.js";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

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
    } as any)) as Record<string, unknown>;

    // Primary assertion: the player-identity guard must NOT wipe the
    // pinned comps (the !body.cardsightCardId short-circuit holds).
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // The pinned-id branch called Cardsight getPricing with the pinned UUID.
    expect(cardSight.getPricing).toHaveBeenCalledWith(PINNED_ID);

    // Legacy CardHedge path NOT invoked for the pinned-id case.
    expect(cardHedge.getCardSales).not.toHaveBeenCalled();
    expect(cardHedge.searchCards).not.toHaveBeenCalled();

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
      source: "card_hedge",
      sale_type: "buy_it_now",
      title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
      url: null,
    }));
    // findCompsByQuery returns the RoutedResult shape (under
    // CARDSIGHT_MODE=off, findCompsRouted delegates here directly).
    (cardHedge.findCompsByQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    } as any)) as Record<string, unknown>;

    // The fall-through path must surface comps.
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // The fall-through path must call findCompsByQuery.
    expect(cardHedge.findCompsByQuery).toHaveBeenCalled();

    // The pinned-id branch (Cardsight getPricing) must NOT be taken.
    expect(cardSight.getPricing).not.toHaveBeenCalled();
  });
});
