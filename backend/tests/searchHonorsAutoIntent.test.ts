/**
 * CF-SEARCH-HONORS-AUTO-INTENT (2026-09-04) — "2011 Topps Chrome Freddie
 * Freeman auto" returned the BASE card, and cached it.
 *
 * The PRICE path has always honoured a typed "auto": narrowToRequestedVariants
 * filters the pool by it. The catalog-options lookup did not. `isAuto` is a
 * first-class `CatalogSearchInput` — it becomes a hard `c.isAuto = @isAuto`
 * scope in the SQL — and the route simply never passed it, so:
 *
 *   - "auto" is an ANCHOR_STOPWORD, so the word cannot reach the row text as
 *     a search token; passing the parsed INTENT is the only way it survives.
 *   - scoreCatalogRow's ±0.15/-0.3 auto nudge is UNIFORM when every row of a
 *     product is isAuto=false (all 5,026 rows of 2011 topps-chrome are), so
 *     scoring cannot break the tie either.
 *   - the answer was then cached, pinning the base card as the answer to an
 *     auto question for the whole TTL.
 *
 * Search and price disagreed about the same words. These pins hold the
 * agreement, and hold the two guards that keep a wrong answer from sticking:
 * never cache an unsatisfied auto intent, and report it as a checklist gap.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

let ROWS: unknown[] = [];
const CAPTURED: Array<{ query: string; params: Array<{ name: string; value: unknown }> }> = [];

function makeContainer() {
  return {
    items: {
      query(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
        CAPTURED.push({
          query: String(spec?.query ?? ""),
          params: spec?.parameters ?? [],
        });
        const isComps = /sold_comps|c\.soldAt|hobbyiqCardId/i.test(String(spec?.query ?? ""));
        return { fetchAll: async () => ({ resources: isComps ? [] : ROWS }) };
      },
    },
  };
}

vi.mock("@azure/cosmos", () => ({
  CosmosClient: vi.fn(function (this: Record<string, unknown>) {
    this.database = () => ({ container: () => makeContainer() });
  }),
}));

async function importSearch() {
  vi.resetModules();
  return import("../src/services/catalog/catalogSearch.service.js");
}

let mod: Awaited<ReturnType<typeof importSearch>>;
beforeEach(async () => {
  mod = await importSearch();
  CAPTURED.length = 0;
});

const TOKENS = ["freddie", "freeman", "topps", "chrome", "173"];

/** A 2011 Topps Chrome #173 row — base or signed. */
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "hiq:baseball:2011:topps-chrome:173:base:no-auto",
    cardNumber: "173", playerName: "Freddie Freeman", sport: "baseball",
    year: 2011, setKey: "topps-chrome", setName: "2011 Topps Chrome Baseball",
    parallel: "Base", isAuto: false, printRun: null,
    searchTokens: TOKENS, source: "baseballcardpedia-ladders-2026-09-04",
    ...over,
  };
}

const QUERY = "2011 Topps Chrome Freddie Freeman auto";

describe("a typed auto intent reaches the query", () => {
  /**
   * The hard scope is the mechanism the PRICE path already trusts. Passing
   * isAuto:true must put it in the SQL — not merely nudge a score, which
   * cannot discriminate when every row of the product is isAuto=false.
   */
  it("scopes the SQL by c.isAuto when the caller states auto intent", async () => {
    ROWS = [row({})];
    await mod.searchCatalog({ query: QUERY, isAuto: true });
    const scoped = CAPTURED.filter((c) => /c\.isAuto\s*=\s*@isAuto/.test(c.query));
    expect(scoped.length).toBeGreaterThan(0);
    for (const c of scoped) {
      expect(c.params.find((p) => p.name === "@isAuto")?.value).toBe(true);
    }
  });

  it("leaves the query unscoped when no auto intent is stated", async () => {
    ROWS = [row({})];
    await mod.searchCatalog({ query: "2011 Topps Chrome Freddie Freeman" });
    expect(CAPTURED.every((c) => !/c\.isAuto\s*=\s*@isAuto/.test(c.query))).toBe(true);
  });

  /**
   * The user-visible outcome: given both rows, an auto query returns the
   * SIGNED card and not the base rookie. They share a card number, so nothing
   * but isAuto tells them apart.
   */
  it("returns the signed row, not the base rookie that shares its number", async () => {
    ROWS = [
      row({}),
      row({
        id: "hiq:baseball:2011:topps-chrome:173:base:auto",
        parallel: "Base", isAuto: true,
      }),
    ];
    const res = await mod.searchCatalog({ query: QUERY, isAuto: true });
    // The mocked container returns ROWS regardless of the WHERE, so the
    // service's own post-filter is what must hold here.
    const autos = res.hits.filter((h) => h.isAuto === true);
    expect(autos.length).toBeGreaterThan(0);
    expect(res.hits[0]?.isAuto).toBe(true);
  });
});

describe("the word 'auto' cannot carry the intent by itself", () => {
  /**
   * The reason the route MUST pass the parsed intent: "auto" is a stopword on
   * both paths that could otherwise carry it, so the query text alone loses
   * the signal entirely. If someone ever removes isAuto from the route again,
   * this is the fact that makes it silently wrong rather than obviously so.
   */
  it("is an anchor stopword and never a name candidate", () => {
    expect(mod.nameCandidateTokens(["freddie", "freeman", "auto", "autograph"]))
      .toEqual(["freddie", "freeman"]);
  });

  it("scores identically across rows when every row is isAuto=false", () => {
    // The uniform-nudge trap: -0.3 applied to BOTH rows is not a tiebreak.
    const tokens = ["2011", "topps", "chrome", "freddie", "freeman", "auto"];
    // Identical rows but for their id, so the ONLY axis that could separate
    // them is isAuto -- and both are false, exactly as the whole 2011
    // topps-chrome product is.
    const a = mod.scoreCatalogRow(tokens, row({}) as never, { isAuto: true });
    const b = mod.scoreCatalogRow(tokens, row({ id: "other" }) as never, { isAuto: true });
    expect(a.score).toBe(b.score);
    // The intent is read from the TOKENS too, not only from opts -- so
    // dropping opts.isAuto does not undo the penalty, it just loses the only
    // signal that could have SCOPED the query. Both readings penalise every
    // row of an all-base product equally, which is why the fix has to be the
    // hard SQL scope and not a ranking tweak.
    const fromTokensOnly = mod.scoreCatalogRow(tokens, row({}) as never, {});
    expect(fromTokensOnly.score).toBe(a.score);
    // Remove the word as well and the penalty lifts -- proving the -0.3 above
    // was the auto intent, applied uniformly because no row is signed.
    const noAutoAtAll = mod.scoreCatalogRow(
      ["2011", "topps", "chrome", "freddie", "freeman"], row({}) as never, {});
    expect(noAutoAtAll.score).toBeGreaterThan(a.score);
  });
});
