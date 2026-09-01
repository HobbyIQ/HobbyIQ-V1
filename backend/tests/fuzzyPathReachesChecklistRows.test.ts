// CF-THE-CATALOG-IS-THE-SEARCH-SURFACE (2026-09-01).
//
// canonicalCardSearch's fuzzy fallback sampled `c.source IN ('cardhedge',
// 'cardsight')` — vendor-era scoping left behind when the primary path grew
// its tree/checklist arm. Checklist rows carry neither vendor source, so a
// typo'd query for a checklist-backed card could never reach the fuzzy path.
//
// These tests DRIVE THE REAL FUNCTION against a fake Cosmos container (the
// suite drives the real function, or it pins nothing). The fake records every
// query it is handed, so the assertions are about the SQL the service actually
// emits and the hits it actually returns — not about a re-implementation.

import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ query: string; parameters?: Array<{ name: string; value: unknown }> }> = [];

/** Rows the fake catalog returns, keyed by which arm asked. */
const state: { primary: unknown[]; tree: unknown[]; sample: unknown[]; sold: unknown[] } = {
  primary: [], tree: [], sample: [], sold: [],
};

function fakeCatalogContainer() {
  return {
    items: {
      query(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) {
        queries.push(spec);
        const q = spec.query;
        // The three catalog arms are told apart by their shape.
        const rows = q.includes("IS_DEFINED(c.searchText)") ? state.sample
          : q.includes("c.kind IN ('card', 'variant')") ? state.tree
            : state.primary;
        return { fetchAll: async () => ({ resources: rows }) };
      },
    },
  };
}
function fakeSoldContainer() {
  return {
    items: {
      query(spec: { query: string }) {
        queries.push(spec);
        return { fetchAll: async () => ({ resources: state.sold }) };
      },
    },
  };
}

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    database() {
      return {
        container: (name: string) => (name === "card_catalog" ? fakeCatalogContainer() : fakeSoldContainer()),
      };
    }
  },
}));

const { canonicalCardSearch } = await import("../src/services/portfolioiq/canonicalCardSearch.service.js");

/** A checklist row as ingest-scraped-checklist writes it: playerName / setKey /
 *  cardNumber, no vendor `source`, no `recentSaleCount`. */
const CHECKLIST_ROW = {
  cardId: "hiq:baseball:2025:topps-chrome:150:base:no-auto",
  playerName: "Paul Skenes",
  setKey: "topps-chrome",
  cardYear: 2025,
  year: "2025",
  cardNumber: "150",
  parallel: null,
  parallelSlug: null,
  isAuto: false,
  sport: "baseball",
  searchText: "2025 topps chrome paul skenes 150",
  searchTokens: ["2025", "topps", "chrome", "paul", "skenes", "150"],
  imageUrl: null,
  kind: "card",
};

/** A vendor row in the legacy shape, for the ranking assertion. */
const VENDOR_ROW = {
  cardId: "ch-9001",
  player: "Paul Skenes",
  releaseName: "Topps Chrome",
  setName: "Topps Chrome",
  year: "2025",
  number: "151",
  parallels: [],
  attributes: [],
  sport: "baseball",
  recentSaleCount: 42,
  searchText: "2025 topps chrome paul skenes 151",
  source: "cardhedge",
};

beforeEach(() => {
  queries.length = 0;
  state.primary = []; state.tree = []; state.sample = []; state.sold = [];
  process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://fake/;AccountKey=Zm9v;";
});

/** The fuzzy sample query is the one that filters on IS_DEFINED(c.searchText). */
const sampleQuery = () => queries.map((s) => s.query).find((q) => q.includes("IS_DEFINED(c.searchText)"));

describe("the fuzzy path is scoped to the catalog, not to the vendors", () => {
  it("no longer restricts the sample to source IN ('cardhedge','cardsight')", async () => {
    // Primary + tree return nothing, so the fuzzy path is the arm under test.
    state.sample = [CHECKLIST_ROW];
    // A one-character typo: "skenez" must fuzzy-match "skenes".
    await canonicalCardSearch({ q: "2025 topps chrome skenez", sport: "baseball" });

    const sq = sampleQuery();
    expect(sq, "the fuzzy sample query should have run").toBeDefined();
    expect(sq).not.toContain("c.source IN ('cardhedge', 'cardsight')");
  });

  it("uses the same verified-tier clause the primary tree arm uses", async () => {
    state.sample = [CHECKLIST_ROW];
    await canonicalCardSearch({ q: "2025 topps chrome skenezz", sport: "baseball" });

    const sq = sampleQuery()!;
    // The verified clause's distinguishing marks: it reasons about absent
    // source/verificationStatus rather than naming two vendors.
    expect(sq).toContain("NOT IS_DEFINED(c.source)");
    expect(sq).toContain("verificationStatus");
  });

  it("RETURNS a checklist row through the fuzzy path — the regression itself", async () => {
    state.sample = [CHECKLIST_ROW];
    const res = await canonicalCardSearch({ q: "2025 topps chrome skenez", sport: "baseball" });

    // Before the fix this was 0: the row was never sampled, so the typo'd
    // query fell through to sold_comps (empty here) and returned nothing.
    expect(res.hits.length).toBeGreaterThan(0);
    const ids = res.hits.map((h: { cardId?: string }) => h.cardId);
    expect(ids).toContain(CHECKLIST_ROW.cardId);
  });

  it("survives the junk-row guard by remapping cardNumber -> number", async () => {
    // The guard drops any row with no `number`. A checklist row spells it
    // `cardNumber`, so without the remap every checklist row is discarded
    // before the fuzzy match is even attempted.
    state.sample = [CHECKLIST_ROW];
    const res = await canonicalCardSearch({ q: "2025 topps chrome zkenes", sport: "baseball" });
    const hit = res.hits.find((h: { cardId?: string }) => h.cardId === CHECKLIST_ROW.cardId) as
      | { number?: string; cardNumber?: string; player?: string; playerName?: string }
      | undefined;
    expect(hit).toBeDefined();
    // The remap carried the identity through, whatever the mapper calls it.
    expect(String(hit!.number ?? hit!.cardNumber)).toBe("150");
    expect(String(hit!.player ?? hit!.playerName)).toBe("Paul Skenes");
  });

  it("still drops a genuinely numberless row", async () => {
    // Widening the source scope must not widen the junk-row guard. A wiki
    // footer row has no usable card number and must stay out.
    state.sample = [{ ...CHECKLIST_ROW, cardId: "junk-1", cardNumber: undefined, number: undefined }];
    const res = await canonicalCardSearch({ q: "2025 topps chrome skenesz", sport: "baseball" });
    expect(res.hits.map((h: { cardId?: string }) => h.cardId)).not.toContain("junk-1");
  });

  it("does not disturb vendor rows the fuzzy path already returned", async () => {
    // The widening is additive: a vendor row that matched before still matches,
    // and its recentSaleCount still feeds the ranking the sources supply.
    state.sample = [VENDOR_ROW, CHECKLIST_ROW];
    const res = await canonicalCardSearch({ q: "topps chrome skenez", sport: "baseball" });
    const ids = res.hits.map((h: { cardId?: string }) => h.cardId);
    expect(ids).toContain(VENDOR_ROW.cardId);
    expect(ids).toContain(CHECKLIST_ROW.cardId);
    // The vendor row carries 42 recent sales against the checklist row's 0, so
    // it must not be displaced by the newly-admitted row.
    expect(ids.indexOf(VENDOR_ROW.cardId)).toBeLessThan(ids.indexOf(CHECKLIST_ROW.cardId));
  });

  it("keeps the fuzzy path a FALLBACK — it does not run when the primary hit", async () => {
    state.primary = [VENDOR_ROW];
    state.sample = [CHECKLIST_ROW];
    await canonicalCardSearch({ q: "2025 topps chrome skenes", sport: "baseball" });
    // The primary returned a candidate, so the expensive TOP 500 sample must
    // never have been issued. Widening its scope must not make it run more.
    expect(sampleQuery()).toBeUndefined();
  });
});
