/**
 * Regression test for the /api/compiq/price-by-id production bug where the
 * player-identity guard wiped valid pinned-card-id comps, PLUS a Phase 2
 * test for the CH-removal meaningful-query fall-through path.
 *
 * Root cause of legacy bug (pre-fix):
 *   fetchComps(query, grade, pinnedCardId) pulls authoritative sales via
 *   getCardSales(card_id). It then looks up identity cosmetically via
 *   searchCards(query) and returns a STUB { title:null, player:null, ... }
 *   when the pinned card_id is not in the top-20 fuzzy hits. The downstream
 *   "Player-identity guard" treats that stub as a fuzzy mismatch and wipes
 *   every comp it just fetched.
 *
 * Legacy fix:
 *   Skip the guard when `body.cardHedgeCardId` is present — pinned-card-id
 *   pulls are authoritative and don't need fuzzy-match defence.
 *
 * Phase 2 CH-removal change (re-applies f5cd3e7's meaningful-query
 * fall-through): when iOS sends a meaningful `query` text alongside
 * cardHedgeCardId, fetchComps falls through to the query path
 * (findCompsRouted → resolveCardId → Cardsight) instead of the legacy
 * cardId-keyed getCardSalesRouted path. The legacy path is reached ONLY when
 * the query is missing or equal to cardHedgeCardId (the iOS resolvedLabel
 * worst-case fallback per CompIQSearchModels.swift).
 *
 * Tests:
 *  1. Legacy-path regression (query === cardHedgeCardId) — scoped to the
 *     legacy branch.
 *  2. Meaningful-query fall-through (Phase 2) — new path routes via
 *     findCompsByQuery (the cardhedge variant of findCompsRouted under
 *     CARDSIGHT_MODE=off test default; under exclusive mode in prod it
 *     routes to Cardsight).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mock the Card Hedge client BEFORE importing the service under test. vi.mock
// calls are hoisted to the top of the file, so the service picks up the mock
// when it resolves its dependency. The path must match the literal specifier
// used by the source: `./cardhedge.client.js` from compiqEstimate.service.ts.
vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  // Legacy pinned-id path uses getCardSales — N fresh sales for our fake card.
  getCardSales: vi.fn(),
  // Legacy pinned-id path uses searchCards only for cosmetic identity.
  searchCards: vi.fn(),
  // Phase 2 meaningful-query fall-through routes via findCompsRouted which
  // under CARDSIGHT_MODE=off (test default) calls findCompsByQuery here.
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

describe("computeEstimate — pinned cardHedgeCardId path", () => {
  const PINNED_ID = "1733687840609x910533527660592800";
  const REAL_QUERY = "2024 Topps Chrome Paul Skenes";

  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: 12 fresh sales (today / yesterday / 2 days ago, rotating).
  function makeFreshSales() {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    return Array.from({ length: 12 }, (_, i) => ({
      price: 40 + i,
      date: isoDaysAgo(i % 5),
      grade: "Raw",
      source: "card_hedge",
      sale_type: "buy_it_now",
      title: "2024 Topps Chrome Update Baseball Paul Skenes #USC150",
      url: null,
    }));
  }

  it("LEGACY path: keeps comps when searchCards identity lookup misses the pinned card_id", async () => {
    // Force the legacy branch by making query === pinnedCardId (the iOS
    // resolvedLabel worst-case fallback). Per Phase 2's CH-removal change,
    // meaningful queries (query !== cardId) bypass this path entirely.
    const QUERY_EQUALS_PINNED = PINNED_ID;

    (cardHedge.getCardSales as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFreshSales(),
    );
    // searchCards returns OTHER cards — pinned card_id not present. Forces
    // fetchComps into the stub-identity branch (title:null, player:null).
    (cardHedge.searchCards as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { card_id: "other-1", title: "Some Other Card", player: "Other Player" },
      { card_id: "other-2", title: "Yet Another", player: "Different Player" },
    ]);

    const result = (await computeEstimate({
      playerName: QUERY_EQUALS_PINNED,
      cardHedgeCardId: PINNED_ID,
    } as any)) as Record<string, unknown>;

    // Primary assertion: the guard must NOT wipe the pinned comps.
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // Sanity: legacy path called getCardSales with the pinned id.
    expect(cardHedge.getCardSales).toHaveBeenCalledWith(
      PINNED_ID,
      expect.any(String),
      expect.any(Number),
    );

    // Sanity: variantWarning must NOT contain "player_mismatch" — that was
    // the literal symptom of the bug.
    const variantWarning = (result.variantWarning as string[] | undefined) ?? [];
    expect(variantWarning).not.toContain("player_mismatch");
  });

  it("PHASE 2: meaningful query falls through to findCompsRouted (bypasses legacy cardId path)", async () => {
    const sales = makeFreshSales();
    // findCompsByQuery returns the RoutedResult shape (under CARDSIGHT_MODE=off,
    // findCompsRouted delegates here directly).
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
      cardHedgeCardId: PINNED_ID,
    } as any)) as Record<string, unknown>;

    // The new path must surface comps.
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // The new path must call findCompsByQuery (the cardhedge variant of
    // findCompsRouted under CARDSIGHT_MODE=off test default).
    expect(cardHedge.findCompsByQuery).toHaveBeenCalled();

    // The new path must NOT call the legacy getCardSales — meaningful-query
    // requests bypass it.
    expect(cardHedge.getCardSales).not.toHaveBeenCalled();
  });
});
