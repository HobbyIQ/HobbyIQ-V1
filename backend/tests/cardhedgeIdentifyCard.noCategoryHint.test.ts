/**
 * Coverage for issue #7 — identifyCard request body no longer carries a
 * `category` hint.
 *
 * Why: case-15 probe (1986 Fleer Michael Jordan PSA 8) showed CH's AI
 * ignores the category hint anyway — with `category: "Baseball"` the
 * service still returned a Basketball Jordan match at confidence 0.96,
 * which the engine then mis-priced as a baseball novelty. Removing the
 * hint stops misleading downstream readers and makes the API call honest
 * about what it actually does. The category truth lives on the response
 * (`match.category`) and is read by computeEstimate's unsupported-sport
 * guard. The search-card fallback (`_searchCards`) remains hard-locked to
 * category="Baseball" so no non-baseball card can leak via that path.
 *
 * This test asserts the wire-level request body so a future "helpful"
 * refactor that re-adds the hint will surface here loudly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import { identifyCard } from "../src/services/compiq/cardhedge.client";

const CARD_MATCH_URL = "https://api.cardhedger.com/v1/cards/card-match";

interface CapturedRequest {
  url: string;
  bodyText: string;
}

function installCapturingFetch(responseBody: unknown): {
  fetchMock: ReturnType<typeof vi.fn>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyText =
      typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    captured.push({ url, bodyText });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fetchMock: fn, captured };
}

describe("identifyCard — request body omits category hint (issue #7)", () => {
  beforeAll(() => {
    process.env.CARD_HEDGE_API_KEY = "test-key";
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs only { query } to /cards/card-match — no category field", async () => {
    const { captured } = installCapturingFetch({
      match: {
        confidence: 0.9,
        card_id: "card-no-hint-test",
        player: "Mike Trout",
        description: "Mike Trout 2011 Topps Update Baseball",
        category: "Baseball",
      },
      candidates_evaluated: 10,
      search_query_used: "Mike Trout 2011 Topps Update",
    });

    await identifyCard("__test_no_category_hint__ Mike Trout 2011 Topps Update");

    expect(captured.length).toBe(1);
    expect(captured[0].url).toBe(CARD_MATCH_URL);

    const parsed = JSON.parse(captured[0].bodyText) as Record<string, unknown>;
    expect(typeof parsed.query).toBe("string");
    expect((parsed.query as string).length).toBeGreaterThan(0);
    // The whole point of the fix: NO category field on the wire.
    expect(parsed).not.toHaveProperty("category");
    expect(Object.keys(parsed)).toEqual(["query"]);
  });

  it("still returns the parsed match — category removal does not break parsing", async () => {
    installCapturingFetch({
      match: {
        confidence: 0.92,
        card_id: "card-parse-after-removal",
        player: "Paul Skenes",
        description: "Paul Skenes 2024 Topps Chrome Update Rookie Debut",
        category: "Baseball",
      },
      candidates_evaluated: 8,
      search_query_used: "Paul Skenes 2024 Topps Chrome",
    });

    const result = await identifyCard(
      "__test_parse_after_removal__ Paul Skenes 2024 Topps Chrome Rookie",
    );

    expect(result).not.toBeNull();
    expect(result!.card_id).toBe("card-parse-after-removal");
    expect((result as any).category).toBe("Baseball");
  });
});
