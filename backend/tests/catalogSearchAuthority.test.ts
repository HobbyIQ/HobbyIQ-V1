/**
 * D33 (Drew, 2026-08-30, on "Find this card" for "2020 BOWMAN Bobby Witt Jr.
 * Royals #BD152 sp": "still a mess").
 *
 * Search returned 65 rows for ONE card and gave the user no way to tell them
 * apart. Three defects in this service, all pinned here:
 *
 *  1. THE HIT CARRIED NO AUTHORITY. `c.source` was SELECTed and then dropped
 *     when the hit was built, so the clients could not distinguish a Beckett
 *     row from one minted off a sale. The badge the picker needs is the same
 *     predicate the holding's VERIFIED stamp already uses
 *     (checklistBackedIdentity: catalogAuthorityOf(source) === "checklist") —
 *     it just had to travel one hop further.
 *
 *  2. NOTHING RANKED ON IT. Order was score then sales count, and a derived row
 *     is minted FROM sales, so it carries the count that wins the tie. A row we
 *     inferred outranked a transcribed checklist card.
 *
 *  3. THE GRADED COLLAPSE USED A SLUG ALLOWLIST. The old test enumerated
 *     raw|psa|bgs|sgc|cgc and had never heard of CSG, HGA or TAG, so
 *     `…:refractor:no-auto:csg-10` read as ungraded, tied with its ungraded
 *     twin and won on arrival order — it was pick #6 on the live page. Picking
 *     it pins a holding to a graded row whose market panel is empty, because
 *     comps hang off the ungraded slug.
 *
 * The rule these share: coverage is never filtered. Every assertion about
 * ORDER is paired with one about PRESENCE.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

process.env.COSMOS_CONNECTION_STRING =
  process.env.COSMOS_CONNECTION_STRING || "AccountEndpoint=https://test/;AccountKey=dGVzdA==;";

/** Rows the mocked container will return; each test sets this before calling. */
let ROWS: unknown[] = [];

/** Every SQL string the service issued — so a test can assert on the QUERY and
 *  not only on the rows a mock hands back regardless of what was asked for. */
const CAPTURED: string[] = [];

// Mock the SDK rather than the container: searchCatalog opens a SECOND handle
// for the sold_comps attach step, and leaving that to a real client is a 30s
// hang that looks exactly like a slow ranking bug.
function makeContainer() {
  return {
    items: {
      query(spec: { query: string }) {
        CAPTURED.push(String(spec?.query ?? ""));
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
});

const TOKENS = ["bobby", "witt", "bowman", "draft", "bd-152"];

/** A 2020 Bowman Draft BD-152 row — the card Drew was actually looking at. */
function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "hiq:baseball:2020:bowman-draft:bd-152:base:no-auto",
    cardNumber: "BD-152", playerName: "Bobby Witt Jr.", sport: "baseball",
    year: 2020, setKey: "bowman-draft", setName: "2020 Bowman Draft Baseball",
    parallel: "Base", isAuto: false, printRun: null,
    searchTokens: TOKENS, source: "baseballcardpedia-ladders-2026-08-29",
    ...over,
  };
}

const QUERY = "Bobby Witt Jr Bowman Draft BD-152";

describe("EVERY query arm selects the fields authority is computed from", () => {
  // The unit tests below all pass through the mocked container, which returns
  // whatever ROWS holds no matter what the SQL asked for — so they cannot see a
  // field missing from a SELECT. That is exactly the bug the live repro found
  // after the rest of this file was green: `c.source` was added to the two wide
  // SELECTs but NOT to `anchorSelectFields`, and the anchor arm is the one that
  // actually serves a real query. Every hit on the live Witt page came back
  // authority "unknown" with no badge on any row.
  //
  // Assert on the SQL TEXT, because that is the only place the omission exists.
  // ASSERT ON THE PROJECTION, NOT THE WHOLE QUERY. `c.source` also appears in
  // the WHERE clause of every verified/provisional arm (verifiedCatalogSqlClause
  // excludes sales-derived, cardhedge, sold-comps-stub… by source), so a
  // `query.toContain("c.source")` is TRUE even when the SELECT list has none —
  // it passes on the exact bug it was written to catch. Verified by mutation:
  // with `c.source` deleted from anchorSelectFields the whole-string form still
  // went green; this form goes red. Cut at the FROM and test only what is
  // projected.
  const projectionOf = (q: string): string => q.slice(0, q.search(/\sFROM\s/i));

  it("names c.source and c.gradeTier in the SELECT LIST of every catalog arm", async () => {
    ROWS = [row({})];
    CAPTURED.length = 0;
    await mod.searchCatalog({ query: QUERY, limit: 25 });
    const catalogQueries = CAPTURED.filter((q) => !/sold_comps|c\.soldAt|hobbyiqCardId/i.test(q));
    expect(catalogQueries.length).toBeGreaterThan(0);
    for (const q of catalogQueries) {
      const projection = projectionOf(q);
      expect(projection, "projection is not a SELECT list: " + q.slice(0, 140)).toMatch(/^SELECT\s/i);
      expect(projection, "SELECT list is missing c.source: " + projection).toContain("c.source");
      expect(projection, "SELECT list is missing c.gradeTier: " + projection).toContain("c.gradeTier");
    }
  });

  it("pins the arms that actually serve Drew's query — the ANCHOR pair", async () => {
    // A query carrying a year AND a card number ("2020 … #BD152") is served by
    // the anchor arms alone; the two wide SELECTs never run for it. That is why
    // adding `c.source` only to the wide SELECTs left every hit on the live page
    // authority "unknown" with no badge. If this count ever drops to 0 the test
    // above is asserting over an empty list and proves nothing.
    ROWS = [row({})];
    CAPTURED.length = 0;
    await mod.searchCatalog({ query: QUERY, limit: 25 });
    const anchors = CAPTURED.filter((q) => /STARTSWITH\(c\.id, 'hiq:'\)/.test(q));
    expect(anchors.length).toBeGreaterThan(0);
    for (const q of anchors) expect(projectionOf(q)).toContain("c.source");
  });
});

describe("every hit says what it is allowed to decide", () => {
  it("classifies each source and round-trips the raw string", async () => {
    ROWS = [
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", source: "baseballcardpedia-ladders-2026-08-29" }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:base:auto", isAuto: true, source: "sold-comps-stub-2026-08-12" }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:blue-foil:no-auto:num-150", parallel: "Blue Foil", printRun: 150, source: "ingest-auto-seed" }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:gold:no-auto:num-50", parallel: "Gold", printRun: 50, source: "cardhedge" }),
    ];
    const res = await mod.searchCatalog({ query: QUERY, limit: 25 });
    const bySlug = new Map(res.hits.map((h) => [h.slug, h]));

    expect(bySlug.get("hiq:baseball:2020:bowman-draft:bd-152:base:no-auto")?.authority).toBe("checklist");
    expect(bySlug.get("hiq:baseball:2020:bowman-draft:bd-152:base:auto")?.authority).toBe("derived");
    expect(bySlug.get("hiq:baseball:2020:bowman-draft:bd-152:blue-foil:no-auto:num-150")?.authority).toBe("derived");
    expect(bySlug.get("hiq:baseball:2020:bowman-draft:bd-152:gold:no-auto:num-50")?.authority).toBe("vendor");

    // The raw source travels too — an audit needs the string, not just the class.
    expect(bySlug.get("hiq:baseball:2020:bowman-draft:bd-152:base:auto")?.source).toBe("sold-comps-stub-2026-08-12");
  });
});

describe("a sale-minted row never outranks a checklist row", () => {
  it("puts the checklist row first even when the derived row scores higher", async () => {
    ROWS = [
      // The derived row is given every advantage: it arrives FIRST, matches the
      // auto context for an extra boost, and carries a large sales count.
      row({
        id: "hiq:baseball:2020:bowman-draft:bd-152:base:auto", isAuto: true,
        source: "sold-comps-stub-2026-08-12",
        salesSummary: { count: 400, lastSaleAt: "2026-08-27T00:00:00Z" },
      }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", source: "baseballcardpedia-ladders-2026-08-29" }),
    ];
    const res = await mod.searchCatalog({
      query: QUERY, limit: 25,
      context: { cardNumber: "BD-152", year: 2020, setName: "Bowman Draft", playerName: "Bobby Witt Jr.", isAuto: true },
    });
    expect(res.hits[0].authority).toBe("checklist");
    expect(res.hits[0].slug).toBe("hiq:baseball:2020:bowman-draft:bd-152:base:no-auto");
    // Reordered, NOT filtered — the derived row is still on the page.
    expect(res.hits.map((h) => h.slug)).toContain("hiq:baseball:2020:bowman-draft:bd-152:base:auto");
  });

  it("still returns the derived rows when NO checklist row matched", async () => {
    // A card we only know through sales must stay findable; that is the whole
    // point of the provisional tier, and a tiering that filtered would undo it.
    ROWS = [
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:base:auto", isAuto: true, source: "sold-comps-stub-2026-08-12" }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:blue-foil:no-auto:num-150", parallel: "Blue Foil", printRun: 150, source: "ingest-auto-seed" }),
    ];
    const res = await mod.searchCatalog({ query: QUERY, limit: 25 });
    expect(res.hits.length).toBe(2);
    expect(res.hits.every((h) => h.authority === "derived")).toBe(true);
  });

  it("keeps score order INSIDE a tier — tiering is a partition, not a re-sort", async () => {
    ROWS = [
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:gold:no-auto:num-50", parallel: "Gold", printRun: 50, source: "beckett-checklist-2026-08-01", searchTokens: ["bobby"] }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", source: "baseballcardpedia-ladders-2026-08-29", searchTokens: TOKENS }),
    ];
    const res = await mod.searchCatalog({ query: QUERY, limit: 25 });
    const checklist = res.hits.filter((h) => h.authority === "checklist");
    expect(checklist.length).toBe(2);
    // The better-scoring checklist row is still first among the checklist rows.
    expect(checklist[0].slug).toBe("hiq:baseball:2020:bowman-draft:bd-152:base:no-auto");
  });
});

describe("a graded twin never represents the card", () => {
  for (const tier of ["csg-10", "hga-10", "psa-10"]) {
    for (const gradedFirst of [true, false]) {
      const where = gradedFirst ? "first" : "second";
      it("collapses " + tier + " into the ungraded slug (graded arrives " + where + ")", async () => {
        const ungraded = row({
          id: "hiq:baseball:2020:bowman-draft:bd-152:refractor:no-auto",
          parallel: "Refractor", printRun: 499,
        });
        const graded = row({
          id: "hiq:baseball:2020:bowman-draft:bd-152:refractor:no-auto:" + tier,
          parallel: "Refractor", printRun: 499, gradeTier: tier,
          source: "baseballcardpedia-ladders-2026-08-29-graded",
          // Give the graded row the sales count so it wins every pre-D33 tiebreak.
          salesSummary: { count: 250, lastSaleAt: "2026-08-27T00:00:00Z" },
        });
        ROWS = gradedFirst ? [graded, ungraded] : [ungraded, graded];
        const res = await mod.searchCatalog({ query: QUERY, limit: 25 });
        // One identity, one row, and it is the ungraded one — comps hang there.
        expect(res.hits.length).toBe(1);
        expect(res.hits[0].slug).toBe("hiq:baseball:2020:bowman-draft:bd-152:refractor:no-auto");
        expect(res.hits[0].gradeTier).toBeNull();
      });
    }
  }

  it("still collapses a graded row that carries NO gradeTier field", async () => {
    // Measured read-only 2026-08-30: 583 rows with a `:psa-` slug and 784 in
    // total carry no gradeTier at all. Reading the field INSTEAD of the slug
    // would have traded the csg-10 leak for a psa-10 one, so graded is either
    // signal — this is the half a field-only test would have lost.
    const ungraded = row({ id: "hiq:baseball:2020:bowman-draft:bd-152:refractor:no-auto", parallel: "Refractor", printRun: 499 });
    const graded = row({
      id: "hiq:baseball:2020:bowman-draft:bd-152:refractor:no-auto:psa-10",
      parallel: "Refractor", printRun: 499,
      // gradeTier deliberately ABSENT, as those 784 rows have it.
      salesSummary: { count: 250, lastSaleAt: "2026-08-27T00:00:00Z" },
    });
    ROWS = [graded, ungraded];
    const res = await mod.searchCatalog({ query: QUERY, limit: 25 });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].slug).toBe("hiq:baseball:2020:bowman-draft:bd-152:refractor:no-auto");
  });
});

describe("preferHit breaks an exact tie on authority", () => {
  it("lets the checklist row represent the card over an identical derived twin", async () => {
    const fields = { parallel: "Black", printRun: 1, isAuto: false };
    ROWS = [
      // Identical identity fields => the same dedupeKey. The derived row arrives
      // first, so arrival order alone would have crowned it.
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:black:no-auto:num-1:stub", source: "catalog-explode-actuals", ...fields }),
      row({ id: "hiq:baseball:2020:bowman-draft:bd-152:black:no-auto:num-1", source: "checklistcenter-2026-08-29", ...fields }),
    ];
    const res = await mod.searchCatalog({ query: QUERY, limit: 25 });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].slug).toBe("hiq:baseball:2020:bowman-draft:bd-152:black:no-auto:num-1");
    expect(res.hits[0].authority).toBe("checklist");
  });
});
