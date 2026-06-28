// CF-CH-CARD-DETAILS-SHAPE-FIX (2026-06-28) — pins the response-shape
// parsing of getCardDetailsById.
//
// PRIOR BUG: my earlier guess at the /v1/cards/card-details response was
// `{card_id, ...}` at top level OR nested `{card: {...}}`. Live verification
// against the prod endpoint on 2026-06-28 showed it actually returns
// `{pages, count, cards: [...]}` — the same shape as /cards/card-search.
// The adapter returned null in this case, which silently disabled the
// CF-CH-MATCH-CARD-BOOST path for cards outside the search window (the
// load-bearing case — Kurtz CPA-NK Green Lava sat outside the top 100
// hits for "nick kurtz green lava auto" so the boost was meant to fetch
// + prepend, and instead never fired).
//
// THIS FILE PINS:
//   1. {cards: [...]} shape with matching card_id returned (live shape)
//   2. {cards: [...]} shape where match by id is found, not just first
//   3. {card: {...}} nested shape (defensive fallback)
//   4. {card_id, ...} top-level shape (defensive fallback)
//   5. Empty cards array → null
//   6. Missing/invalid shape → null

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCardDetailsById } from "../src/services/compiq/cardhedge.client.js";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.CARD_HEDGE_API_KEY = "test-key-for-shape-tests";
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchResponse(body: unknown, status = 200): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as any) as any;
}

// Unique ids per test — getCardDetailsById uses cacheWrap, so reusing
// a cardId across tests yields cache hits and the first response shape
// pollutes every subsequent test.
let __testCounter = 0;
function uniqueId(): string {
  __testCounter += 1;
  return `test-kurtz-id-shape-${__testCounter}`;
}

describe("getCardDetailsById — response shape parsing", () => {
  it("LIVE shape: {pages, count, cards: [...]} returns the matching card", async () => {
    const id = uniqueId();
    mockFetchResponse({
      pages: 1,
      count: 1,
      cards: [
        {
          card_id: id,
          player: "Nick Kurtz",
          number: "CPA-NK",
          variant: "Green Lava Refractor",
          set: "2025 Bowman Chrome Prospects Baseball",
          year: 2025,
        },
      ],
    });
    const card = await getCardDetailsById(id);
    expect(card).not.toBeNull();
    expect(card!.card_id).toBe(id);
    expect(card!.variant).toBe("Green Lava Refractor");
  });

  it("cards array with multiple entries → picks the one with matching card_id, not just first", async () => {
    const id = uniqueId();
    mockFetchResponse({
      cards: [
        { card_id: "wrong-id-1", player: "Other" },
        { card_id: id, player: "Nick Kurtz", variant: "Green Lava" },
        { card_id: "wrong-id-2", player: "Other" },
      ],
    });
    const card = await getCardDetailsById(id);
    expect(card!.card_id).toBe(id);
    expect(card!.player).toBe("Nick Kurtz");
  });

  it("cards array with no exact match → falls back to first entry (defensive)", async () => {
    const id = uniqueId();
    mockFetchResponse({
      cards: [
        { card_id: "fallback-id", player: "Fallback" },
      ],
    });
    const card = await getCardDetailsById(id);
    // Better to return something than nothing if the API returned cards
    // but none with the exact id (shouldn't happen in practice).
    expect(card!.card_id).toBe("fallback-id");
  });

  it("nested {card: {...}} shape (defensive fallback) returns the card", async () => {
    const id = uniqueId();
    mockFetchResponse({
      card: {
        card_id: id,
        player: "Nick Kurtz",
        variant: "Green Lava",
      },
    });
    const card = await getCardDetailsById(id);
    expect(card!.card_id).toBe(id);
  });

  it("top-level {card_id, ...} shape (defensive fallback) returns the card", async () => {
    const id = uniqueId();
    mockFetchResponse({
      card_id: id,
      player: "Nick Kurtz",
      variant: "Green Lava",
    });
    const card = await getCardDetailsById(id);
    expect(card!.card_id).toBe(id);
  });

  it("empty cards array → null (no fallback to top-level)", async () => {
    const id = uniqueId();
    mockFetchResponse({ pages: 0, count: 0, cards: [] });
    const card = await getCardDetailsById(id);
    expect(card).toBeNull();
  });

  it("response missing card data entirely → null", async () => {
    const id = uniqueId();
    mockFetchResponse({ error: "not found" });
    const card = await getCardDetailsById(id);
    expect(card).toBeNull();
  });

  it("HTTP 404 → null (graceful degrade)", async () => {
    const id = uniqueId();
    mockFetchResponse({}, 404);
    const card = await getCardDetailsById(id);
    expect(card).toBeNull();
  });
});
