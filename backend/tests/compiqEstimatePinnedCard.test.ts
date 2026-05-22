/**
 * Regression test for the /api/compiq/price-by-id production bug where the
 * player-identity guard wiped valid pinned-card-id comps.
 *
 * Root cause (pre-fix):
 *   fetchComps(query, grade, pinnedCardId) pulls authoritative sales via
 *   getCardSales(card_id). It then looks up identity cosmetically via
 *   searchCards(query) and returns a STUB { title:null, player:null, ... }
 *   when the pinned card_id is not in the top-20 fuzzy hits. The downstream
 *   "Player-identity guard" treats that stub as a fuzzy mismatch and wipes
 *   every comp it just fetched.
 *
 * Fix:
 *   Skip the guard when `body.cardHedgeCardId` is present — pinned-card-id
 *   pulls are authoritative and don't need fuzzy-match defence.
 *
 * This test asserts: given a pinned cardHedgeCardId whose getCardSales
 * returns N comps but whose searchCards results DO NOT include that card_id,
 * computeEstimate must surface N comps (compsUsed > 0), not 0.
 *
 * Without the fix this test fails (compsUsed === 0, source === "no-recent-comps").
 * With the fix it passes.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mock the Card Hedge client BEFORE importing the service under test. vi.mock
// calls are hoisted to the top of the file, so the service picks up the mock
// when it resolves its dependency. The path must match the literal specifier
// used by the source: `./cardhedge.client.js` from compiqEstimate.service.ts.
vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  // Pinned-id path uses getCardSales — N fresh sales for our fake card.
  getCardSales: vi.fn(),
  // Pinned-id path uses searchCards only for cosmetic identity. Return hits
  // that do NOT contain the pinned card_id so fetchComps falls back to the
  // stub identity (title:null, player:null) — the exact production scenario.
  searchCards: vi.fn(),
  // Not exercised on the pinned path but must exist for import resolution.
  findCompsByQuery: vi.fn(),
}));

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import * as cardHedge from "../src/services/compiq/cardhedge.client.js";

describe("computeEstimate — pinned cardHedgeCardId path (regression for /price-by-id wipe)", () => {
  const PINNED_ID = "1733687840609x910533527660592800";
  const QUERY = "2024 Topps Chrome Paul Skenes";

  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps comps when searchCards identity lookup misses the pinned card_id", async () => {
    // 12 fresh sales (today / yesterday / 2 days ago, rotating).
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
    (cardHedge.getCardSales as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(sales);

    // searchCards returns OTHER cards — pinned card_id not present. Forces
    // fetchComps into the stub-identity branch (title:null, player:null).
    (cardHedge.searchCards as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { card_id: "other-1", title: "Some Other Card", player: "Other Player" },
      { card_id: "other-2", title: "Yet Another", player: "Different Player" },
    ]);

    const result = (await computeEstimate({
      playerName: QUERY,
      cardHedgeCardId: PINNED_ID,
    } as any)) as Record<string, unknown>;

    // Primary assertion: the guard must NOT wipe the pinned comps.
    expect(result.compsUsed).toBeGreaterThan(0);
    expect(result.source).not.toBe("no-recent-comps");

    // Sanity: getCardSales was called with the pinned id.
    expect(cardHedge.getCardSales).toHaveBeenCalledWith(
      PINNED_ID,
      expect.any(String),
      expect.any(Number)
    );

    // Sanity: variantWarning must NOT contain "player_mismatch" — that was
    // the literal symptom of the bug.
    const variantWarning = (result.variantWarning as string[] | undefined) ?? [];
    expect(variantWarning).not.toContain("player_mismatch");
  });
});
