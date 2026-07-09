// CF-COLD-META-FALLBACK (2026-07-09, Drew — Owen Carey 2026 Bowman Black).
//
// Regression guard: the GET /api/compiq/observed-grade-curve/:cardId route
// used to bail on identity enrichment when the meta cache was cold — a
// card that had never surfaced through search would come back with
// playerName=null, which cascaded through the trajectory + sibling-fallback
// paths into an all-null grade curve. iOS opening the card by direct
// cardId saw "no data" for every grade even when the card exists in CH
// and its siblings are actively priced.
//
// This test verifies: when getCardMetaById returns null but
// getCardDetailsById returns a valid CH card, the route uses CH's details
// to recover playerName and identity enrichment fires.

import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// getCardMetaById cold, getCardDetailsById warm.
vi.mock("../src/services/compiq/cardhedge.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    // Cold observed-grade-curve trigger: no cache entry.
    // (getCardMetaById lives in cardsight.router, not cardhedge.client —
    // mocked separately below.)
    getCardDetailsById: vi.fn(async (cardId: string) => ({
      card_id: cardId,
      player: "Owen Carey",
      set: "2026 Bowman Baseball",
      number: "BCP-69",
      variant: "Black Refractor",
      subset: "Chrome Prospects",
      description: "Owen Carey 2026 Bowman Chrome Prospects Black Refractor",
      image: "",
      category: "Baseball",
    })),
    getPricesByCard: vi.fn(async () => []),
    getAllPricesByCard: vi.fn(async () => []),
    getCardSales: vi.fn(async () => []),
    searchCards: vi.fn(async () => []),
    identifyCard: vi.fn(async () => null),
  };
});

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    // Meta cache returns null → the fallback path fires.
    getCardMetaById: vi.fn(async () => null),
    getCardSalesRouted: vi.fn(async () => []),
    searchCardsRouted: vi.fn(async () => []),
    findCompsRouted: vi.fn(async () => ({
      card: null,
      sales: [],
      variantWarning: [],
      aiCategory: "Baseball",
    })),
  };
});

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => ({
      userId: "test-user",
      email: "t@t",
      username: null,
      fullName: null,
      plan: "pro_seller",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  };
});

import app from "../src/app";

describe("CF-COLD-META-FALLBACK — /observed-grade-curve recovers identity from CH details", () => {
  it("uses getCardDetailsById when meta cache is cold, so playerName propagates", async () => {
    // Any UUID-shaped cardId — the mock ignores content and returns
    // Owen Carey details regardless.
    const cid = "1778477531904x850967262057528600";
    const res = await request(app)
      .get(`/api/compiq/observed-grade-curve/${cid}`)
      .set("x-session-id", "test-sess");

    expect(res.status).toBe(200);
    // The corpus emission log payload records the enrichment attempt.
    // The critical wire fields: cardId echoes, entries array populated.
    expect(res.body.cardId).toBe(cid);
    expect(Array.isArray(res.body.entries)).toBe(true);
    // Regression key: BEFORE this CF, playerName=null → trajectory bailed
    // → signalSource=null AND all entries had valueSource=unavailable.
    // AFTER: at minimum the fallback path attempted enrichment. We can't
    // assert signalSource is populated (that depends on downstream mocks
    // for matched-cohort), but we CAN assert getCardDetailsById was
    // consulted, meaning identity enrichment did NOT short-circuit.
    const { getCardDetailsById } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    expect(vi.mocked(getCardDetailsById)).toHaveBeenCalledWith(cid);
  });

  it("does NOT fall back when meta cache already has the player populated", async () => {
    // Prime the cache mock to return a real RoutedCard.
    const { getCardMetaById } = await import(
      "../src/services/compiq/cardsight.router.js"
    );
    vi.mocked(getCardMetaById).mockResolvedValueOnce({
      card_id: "abc",
      title: "Test Card",
      player: "Warm Cache Player",
      set: "2026 Bowman Baseball",
      year: 2026,
      number: "BCP-1",
      variant: "Base",
    } as unknown as any);

    const { getCardDetailsById } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(getCardDetailsById).mockClear();

    const res = await request(app)
      .get(`/api/compiq/observed-grade-curve/abc`)
      .set("x-session-id", "test-sess");

    expect(res.status).toBe(200);
    // Cache hit path: getCardDetailsById is NOT called because meta.player
    // was already present. Guards against burning a CH call on every warm
    // request.
    expect(vi.mocked(getCardDetailsById)).not.toHaveBeenCalled();
  });
});
