/**
 * Unit coverage for cardhedge.client.identifyCard response-shape parsing.
 *
 * Bug being prevented (regression coverage):
 *   CH /cards/card-match returns
 *     { match: {card_id, confidence, …} | null,
 *       candidates_evaluated,
 *       search_query_used }
 *   The previous parser read `body.confidence` / `body.card_id` at the top
 *   level (which are always undefined), so Number(undefined ?? 0) = 0 and
 *   identifyCard returned null for every query in production. The AI-match
 *   fast path inside findCompsByQuery was silently disabled for months,
 *   forcing every prediction down the searchCards fallback path.
 *
 * Mocks the network at `global.fetch` so we exercise the real cache wrapper
 * and the real parser. Each test uses a unique query string so the
 * in-memory cache (no Redis in test) never returns a stale hit.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import { identifyCard } from "../src/services/compiq/cardhedge.client";

const CARD_MATCH_URL = "https://api.cardhedger.com/v1/cards/card-match";

/** Build a `fetch` mock that returns `body` as JSON with HTTP 200. */
function mockFetchOnce(body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Real Paul Skenes Rookie 1 response captured live from CH on 2026-05-15. */
const SKENES_ROOKIE_1_RESPONSE = {
  match: {
    confidence: 0.85,
    reasoning:
      "The user request specifies a 2024 Topps Chrome rookie card for Paul Skenes. Among the candidates, entry 1 is the only card explicitly labeled as a 'Rookie Debut' and belongs to the 2024 Topps Chrome Update set, which is a Chrome variant.",
    description: "Paul Skenes 2024 Topps Chrome Update Rookie Debut Baseball",
    player: "Paul Skenes",
    set: "2024 Topps Chrome Update Baseball",
    number: "USC27",
    variant: "Base",
    card_id: "1733687824006x498842272323170500",
    image:
      "https://942284f33c575895b4be9de571ca6e40.cdn.bubble.io/d112/f1737314763836x974028147627900000/s-l1600-102.jpg",
    category: "Baseball",
    prices: [
      { grade: "PSA 10", price: "144.5" },
      { grade: "PSA 9", price: "20.05" },
      { grade: "Raw", price: "6.17" },
    ],
  },
  candidates_evaluated: 10,
  search_query_used: "2024 Topps Chrome Paul Skenes Rookie 1",
};

describe("identifyCard — response-shape parser", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("golden file: parses the real Paul Skenes Rookie 1 response", async () => {
    const fetchMock = mockFetchOnce(SKENES_ROOKIE_1_RESPONSE);

    const result = await identifyCard("__test_golden_skenes_rookie_1__");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      CARD_MATCH_URL,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).not.toBeNull();
    expect(result!.card_id).toBe("1733687824006x498842272323170500");
    expect(result!.confidence).toBe(0.85);
    expect(result!.player).toBe("Paul Skenes");
    // description → title mirror so cardMatchesTokens.candidateText sees it.
    expect(result!.title).toBe("Paul Skenes 2024 Topps Chrome Update Rookie Debut Baseball");
  });

  it("returns the card object when match has confidence >= 0.80", async () => {
    mockFetchOnce({
      match: {
        confidence: 0.9,
        card_id: "card-abc",
        player: "Mike Trout",
        description: "Mike Trout 2011 Topps Update Baseball",
      },
      candidates_evaluated: 10,
      search_query_used: "trout",
    });

    const result = await identifyCard("__test_trout_high_confidence__");

    expect(result).not.toBeNull();
    expect(result!.card_id).toBe("card-abc");
    expect(result!.confidence).toBe(0.9);
  });

  it("returns null when match is null (CH AI declined)", async () => {
    mockFetchOnce({
      match: null,
      candidates_evaluated: 10,
      search_query_used: "fictional",
    });

    const result = await identifyCard("__test_match_null__");
    expect(result).toBeNull();
  });

  it("returns null when match.confidence is below MIN_IDENTITY_CONFIDENCE (0.80)", async () => {
    mockFetchOnce({
      match: {
        confidence: 0.79,
        card_id: "card-weak",
        player: "Ambiguous",
        description: "Ambiguous Card 2024",
      },
      candidates_evaluated: 10,
      search_query_used: "weak",
    });

    const result = await identifyCard("__test_low_confidence__");
    expect(result).toBeNull();
  });

  it("returns null when match.card_id is missing", async () => {
    mockFetchOnce({
      match: {
        confidence: 0.95,
        // card_id absent
        player: "Someone",
        description: "Some Card",
      },
      candidates_evaluated: 10,
      search_query_used: "no-id",
    });

    const result = await identifyCard("__test_missing_card_id__");
    expect(result).toBeNull();
  });

  it("returns null on HTTP non-2xx", async () => {
    const fn = vi.fn(async () => new Response("error", { status: 500 }));
    vi.stubGlobal("fetch", fn);

    const result = await identifyCard("__test_http_500__");
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON response", async () => {
    const fn = vi.fn(async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fn);

    const result = await identifyCard("__test_bad_json__");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fn);

    const result = await identifyCard("__test_network_throw__");
    expect(result).toBeNull();
  });

  it("regression: rejects the legacy top-level body shape (no match wrapper)", async () => {
    // What the old buggy parser USED to accept — confidence/card_id at top
    // level. The current CH API does not return this shape; if a future
    // shape change emits it again, this test will fire and force a refresh
    // of the parser instead of silently accepting partial data.
    mockFetchOnce({
      card_id: "legacy-flat-card",
      confidence: 0.99,
      player: "Legacy",
    });

    const result = await identifyCard("__test_legacy_flat_shape__");
    expect(result).toBeNull();
  });

  it("maps description -> title when title is absent in the match payload", async () => {
    mockFetchOnce({
      match: {
        confidence: 0.95,
        card_id: "card-with-desc",
        description: "Some Player 2024 Set Number 1 Refractor",
        // no title field
      },
      candidates_evaluated: 10,
      search_query_used: "desc-only",
    });

    const result = await identifyCard("__test_description_to_title__");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Some Player 2024 Set Number 1 Refractor");
  });
});
