/**
 * CF-SEARCH-RANK-AGAINST-THE-HOLDING (Drew, 2026-08-23: "that search should put
 * best matches at the top").
 *
 * The review queue's search-and-pick is not a free-text search — it is
 * identifying a card the user already owns, and the import already parsed a
 * year, a number and a set off the listing. Token overlap alone cannot use any
 * of that: a 2024 and a 2025 card with the same player score identically.
 *
 * Passing that context boosts agreeing hits. It must NEVER filter: every one of
 * those fields came from a title parse already shown to be unreliable — that is
 * why the card reached a human at all — so a wrong parse must reorder the page,
 * never hide the right answer.
 *
 * Ranking lives in the service so iOS and web share one definition. Two copies
 * of a ranking rule drift, which is what happened to the player-name matcher
 * this week.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

async function importSearch() {
  vi.resetModules();
  return import("../src/services/catalog/catalogSearch.service.js");
}

/** Three Max Williams cards that a plain token search cannot separate: same
 *  player, same number, different year and different parallel. */
const ROWS = [
  {
    id: "hiq:baseball:2024:bowman:cpa-mwi:base:auto",
    cardNumber: "CPA-MWI", playerName: "Max Williams", sport: "baseball",
    year: 2024, setKey: "bowman", setName: "Bowman", parallel: "Base",
    isAuto: true, searchTokens: ["max", "williams", "bowman", "cpa-mwi"],
  },
  {
    id: "hiq:baseball:2025:bowman-draft:cpa-mwi:blue-refractor:auto:num-150",
    cardNumber: "CPA-MWI", playerName: "Max Williams", sport: "baseball",
    year: 2025, setKey: "bowman-draft", setName: "Bowman Draft", parallel: "Blue Refractor",
    isAuto: true, searchTokens: ["max", "williams", "bowman", "draft", "cpa-mwi"],
  },
  {
    id: "hiq:baseball:2025:bowman-draft:cpa-mwi:base:auto:num-15",
    cardNumber: "CPA-MWI", playerName: "Max Williams", sport: "baseball",
    year: 2025, setKey: "bowman-draft", setName: "Bowman Draft", parallel: "Base",
    isAuto: true, searchTokens: ["max", "williams", "bowman", "draft", "cpa-mwi"],
  },
];

// Mock the SDK, not just the catalog container. searchCatalog also opens a
// SEPARATE handle for the sold_comps attach step, and __setCatalogContainerForTest
// does not cover it — leaving that one to resolve a real client is a 30s hang
// per test that looks exactly like a slow ranking bug.
function makeContainer(rows: unknown[]) {
  return {
    items: {
      query(spec: { query: string }) {
        // Comps queries must come back empty; only catalog rows are under test.
        const isComps = /sold_comps|c\.soldAt|hobbyiqCardId/i.test(String(spec?.query ?? ""));
        return { fetchAll: async () => ({ resources: isComps ? [] : rows }) };
      },
    },
  };
}

vi.mock("@azure/cosmos", () => ({
  CosmosClient: vi.fn(function (this: Record<string, unknown>) {
    this.database = () => ({ container: () => makeContainer(ROWS) });
  }),
}));

let mod: Awaited<ReturnType<typeof importSearch>>;

beforeEach(async () => {
  mod = await importSearch();
});


describe("catalog search ranks against the holding being identified", () => {
  it("floats the year+set the holding actually is to the top", async () => {
    const withoutCtx = await mod.searchCatalog({ query: "Max Williams CPA-MWI", limit: 10 });
    const withCtx = await mod.searchCatalog({
      query: "Max Williams CPA-MWI",
      limit: 10,
      context: { cardNumber: "CPA-MWI", year: 2025, setName: "Bowman Draft", playerName: "Max Williams", isAuto: true },
    });
    expect(withCtx.hits.length).toBeGreaterThan(0);
    // The 2024 Bowman card must not be first once we know it is a 2025 Draft.
    expect(withCtx.hits[0].year).toBe(2025);
    expect(withCtx.hits[0].setKey).toBe("bowman-draft");
    // And the context genuinely changed the order rather than the query alone
    // deciding it — otherwise this test proves nothing about the boost.
    const rank = (r: typeof withCtx) => r.hits.findIndex((h) => h.year === 2025 && h.setKey === "bowman-draft");
    expect(rank(withCtx)).toBeLessThanOrEqual(rank(withoutCtx));
  });

  it("still returns every candidate — a boost orders, it never filters", async () => {
    const res = await mod.searchCatalog({
      query: "Max Williams CPA-MWI",
      limit: 10,
      // A DELIBERATELY WRONG context, as a bad title parse would produce.
      context: { cardNumber: "CPA-MWI", year: 1999, setName: "Topps Heritage", playerName: "Max Williams", isAuto: false },
    });
    // The right card is still reachable. If a wrong parse could hide it, the
    // user would have no way to correct the very thing they were asked to fix.
    const slugs = res.hits.map((h) => h.slug);
    expect(slugs).toContain("hiq:baseball:2025:bowman-draft:cpa-mwi:base:auto:num-15");
  });

  it("behaves exactly as before when no context is supplied", async () => {
    const a = await mod.searchCatalog({ query: "Max Williams CPA-MWI", limit: 10 });
    const b = await mod.searchCatalog({ query: "Max Williams CPA-MWI", limit: 10, context: null });
    expect(b.hits.map((h) => h.slug)).toEqual(a.hits.map((h) => h.slug));
  });
});
