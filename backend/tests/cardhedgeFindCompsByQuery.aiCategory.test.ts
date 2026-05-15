/**
 * Coverage for issue #7 — findCompsByQuery surfaces Card Hedge's AI sport
 * category to the caller via `result.aiCategory`.
 *
 * The unsupported-sport guard in compiqEstimate.service.ts reads this
 * field; if findCompsByQuery ever stops forwarding it, non-baseball
 * cards (Jordan, Doncic, Herbert) will silently fall back to being
 * mis-priced as baseball novelties.
 *
 * Mocks at `global.fetch` so the real cache wrapper and real parser run.
 * Each test uses a unique query string so the in-memory cache never
 * returns a stale hit.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import { findCompsByQuery } from "../src/services/compiq/cardhedge.client";

const CARD_MATCH_URL = "https://api.cardhedger.com/v1/cards/card-match";
const CARD_SEARCH_URL = "https://api.cardhedger.com/v1/cards/card-search";
const COMPS_URL = "https://api.cardhedger.com/v1/cards/comps";

const FAKE_COMPS = {
  raw_prices: [
    { price: "100.00", sale_date: "2026-05-10", grade: "Raw", title: "test comp 1" },
    { price: "95.00", sale_date: "2026-05-08", grade: "Raw", title: "test comp 2" },
  ],
};

function installFetchRouter(matchBody: unknown): { fetchMock: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === CARD_MATCH_URL) {
      return new Response(JSON.stringify(matchBody), {
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
      return new Response(JSON.stringify({ cards: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fn);
  return { fetchMock: fn };
}

describe("findCompsByQuery — aiCategory plumbing (issue #7)", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces non-baseball category from CH AI match (Basketball)", async () => {
    installFetchRouter({
      match: {
        confidence: 0.95,
        card_id: "card-jordan-1986-fleer-aicategory-test",
        player: "Michael Jordan",
        set: "1986 Fleer Basketball",
        number: "57",
        variant: "Base",
        description: "Michael Jordan 1986 Fleer Basketball Rookie",
        category: "Basketball",
      },
      candidates_evaluated: 12,
      search_query_used: "Michael Jordan 1986 Fleer",
    });

    const result = await findCompsByQuery(
      "__test_aicategory_basketball__ 1986 Fleer Michael Jordan",
      { grade: "PSA 8", limit: 10 },
    );

    expect(result.card).not.toBeNull();
    expect(result.aiCategory).toBe("Basketball");
  });

  it("surfaces Baseball category when CH AI confirms it", async () => {
    installFetchRouter({
      match: {
        confidence: 0.93,
        card_id: "card-trout-2011-aicategory-test",
        player: "Mike Trout",
        set: "2011 Topps Update Baseball",
        number: "US175",
        variant: "Base",
        description: "Mike Trout 2011 Topps Update Baseball",
        category: "Baseball",
      },
      candidates_evaluated: 8,
      search_query_used: "Mike Trout 2011 Topps Update",
    });

    const result = await findCompsByQuery(
      "__test_aicategory_baseball__ Mike Trout 2011 Topps Update",
      { grade: "Raw", limit: 10 },
    );

    expect(result.aiCategory).toBe("Baseball");
  });

  it("returns aiCategory=null when AI match has no category field", async () => {
    installFetchRouter({
      match: {
        confidence: 0.91,
        card_id: "card-no-category-field",
        player: "Mike Trout",
        description: "Mike Trout 2011 Topps Update",
        // no category field
      },
      candidates_evaluated: 6,
      search_query_used: "Mike Trout 2011 Topps Update",
    });

    const result = await findCompsByQuery(
      "__test_aicategory_missing__ Mike Trout 2011 Topps Update",
      { grade: "Raw", limit: 10 },
    );

    expect(result.aiCategory).toBeNull();
  });

  it("returns aiCategory=null when AI match is null (low confidence / no match)", async () => {
    installFetchRouter({
      match: null,
      candidates_evaluated: 4,
      search_query_used: "Unknown Player",
    });

    const result = await findCompsByQuery(
      "__test_aicategory_no_match__ Unknown Player 2026",
      { grade: "Raw", limit: 10 },
    );

    // Hits searchCards fallback which returns empty cards array in the mock,
    // so card is null too — but aiCategory must explicitly be null.
    expect(result.aiCategory).toBeNull();
  });
});
