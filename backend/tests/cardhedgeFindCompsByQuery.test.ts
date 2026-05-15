/**
 * Coverage for the findCompsByQuery → identifyCard (L383) call site.
 *
 * What it asserts:
 *   When CH /cards/card-match returns a high-confidence match whose card
 *   passes cardMatchesTokens, findCompsByQuery must:
 *     - use the AI candidate directly,
 *     - call /cards/comps with that card_id, and
 *     - SKIP /cards/card-search entirely (no fallback hop).
 *
 * Why this matters: the production bug made identifyCard always return
 * null, forcing every query through searchCards. Once the parser is
 * fixed, this test guards the L383 wiring so a future refactor doesn't
 * regress the fast path by accidentally ignoring `aiCandidate`.
 *
 * Mocks at the `global.fetch` boundary so the real cache wrapper and real
 * parser run end-to-end. Unique query strings avoid in-memory cache reuse.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import { findCompsByQuery } from "../src/services/compiq/cardhedge.client";

const CARD_MATCH_URL = "https://api.cardhedger.com/v1/cards/card-match";
const CARD_SEARCH_URL = "https://api.cardhedger.com/v1/cards/card-search";
const COMPS_URL = "https://api.cardhedger.com/v1/cards/comps";

const AI_CARD_ID = "card-test-aimatch-trout-2011";

const HIGH_CONFIDENCE_MATCH = {
  match: {
    confidence: 0.95,
    card_id: AI_CARD_ID,
    player: "Mike Trout",
    set: "2011 Topps Update Baseball",
    number: "US175",
    variant: "Base",
    description: "Mike Trout 2011 Topps Update Baseball",
    prices: [{ grade: "Raw", price: "150.0" }],
  },
  candidates_evaluated: 10,
  search_query_used: "Mike Trout 2011 Topps Update",
};

const FAKE_COMPS = {
  raw_prices: [
    { price: "152.50", sale_date: "2026-05-10", grade: "Raw", title: "2011 Topps Update Mike Trout US175" },
    { price: "148.00", sale_date: "2026-05-08", grade: "Raw", title: "2011 Topps Update Mike Trout US175" },
    { price: "150.00", sale_date: "2026-05-05", grade: "Raw", title: "2011 Topps Update Mike Trout US175" },
  ],
};

/** Route fetch to per-URL responses; records every call URL. */
function installFetchRouter(): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url === CARD_MATCH_URL) {
      return new Response(JSON.stringify(HIGH_CONFIDENCE_MATCH), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === COMPS_URL) {
      return new Response(JSON.stringify(FAKE_COMPS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === CARD_SEARCH_URL) {
      // Should NOT be called on the happy path. Returning empty so a
      // regression that DOES hit search still passes through visibly.
      return new Response(JSON.stringify({ cards: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected URL", { status: 500 });
  });
  vi.stubGlobal("fetch", fn);
  return { fetchMock: fn, calls };
}

describe("findCompsByQuery — AI-match fast path (L383 wiring)", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the AI candidate and skips /cards/card-search when tokens match", async () => {
    const { calls } = installFetchRouter();

    const result = await findCompsByQuery(
      "__test_findcomps_aimatch_trout_2011__ Mike Trout 2011 Topps Update",
      { grade: "Raw", limit: 10 },
    );

    // Card resolved to the AI match — no fallback variantWarning.
    expect(result.card).not.toBeNull();
    expect(result.card!.card_id).toBe(AI_CARD_ID);
    expect(result.variantWarning).toEqual([]);

    // Comps came through.
    expect(result.sales.length).toBe(3);
    expect(result.sales[0].price).toBeCloseTo(152.5, 2);

    // The L383 fast path: card-match was called, comps was called, but
    // card-search MUST NOT be invoked.
    expect(calls).toContain(CARD_MATCH_URL);
    expect(calls).toContain(COMPS_URL);
    expect(calls).not.toContain(CARD_SEARCH_URL);
  });

  it("falls through to /cards/card-search when identifyCard returns null", async () => {
    // Different query to dodge the in-memory cache from the previous test.
    const calls: string[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url === CARD_MATCH_URL) {
        // CH AI declined → match: null
        return new Response(
          JSON.stringify({ match: null, candidates_evaluated: 10, search_query_used: "x" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CARD_SEARCH_URL) {
        return new Response(
          JSON.stringify({
            cards: [
              {
                card_id: "search-fallback-card",
                player: "Mike Trout",
                set: "2011 Topps Update Baseball",
                number: "US175",
                variant: "Base",
                title: "Mike Trout 2011 Topps Update Baseball",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === COMPS_URL) {
        return new Response(JSON.stringify(FAKE_COMPS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected URL", { status: 500 });
    });
    vi.stubGlobal("fetch", fn);

    const result = await findCompsByQuery(
      "__test_findcomps_aimatch_null_fallback__ Mike Trout 2011 Topps Update",
      { grade: "Raw", limit: 10 },
    );

    expect(result.card).not.toBeNull();
    expect(result.card!.card_id).toBe("search-fallback-card");
    expect(calls).toContain(CARD_MATCH_URL);
    expect(calls).toContain(CARD_SEARCH_URL);
    expect(calls).toContain(COMPS_URL);
  });
});
