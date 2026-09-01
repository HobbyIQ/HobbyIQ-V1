/**
 * Drew, 2026-09-01: "Fix the root cause — deriveCatalogEntry should build its
 * own search fields."
 *
 * catalogSearch discriminates with ARRAY_CONTAINS(c.searchTokens, @t). A row
 * without them exists and can never be returned by any query. deriveCatalogEntry
 * did not write them, so every checklist ingested through
 * ingest-scraped-checklist landed search-invisible and needed a repair behind
 * it — 0 of 78 rows from #1612 had tokens, against 2179 of 2179 on an
 * established checklist.
 *
 * The derivation must stay IDENTICAL to catalogRowOps.rebuildSearchFields, or a
 * row minted here and the same row healed there disagree, and the coverage
 * canary reads one of them as stale.
 */
import { describe, expect, it } from "vitest";
import { deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service";
import { rebuildSearchFields } from "../src/services/catalog/catalogRowOps.service";

const base = {
  sport: "baseball",
  year: 2018,
  setKey: "bowman-chrome",
  cardNumber: "1",
  parallel: "Carrying Bag Image Variation SP",
  isAuto: false,
  printRun: null,
  playerName: "Shohei Ohtani",
  source: "beckett-scraped-2026-09-01" as never,
  confidence: 0.95,
};

describe("deriveCatalogEntry builds its own search fields", () => {
  it("a minted row is findable — tokens, text and display name are all present", () => {
    const e = deriveCatalogEntry({ ...base, setName: "2018 Bowman Chrome" }) as never as Record<string, unknown>;
    expect(e).toBeTruthy();
    expect(Array.isArray(e.searchTokens)).toBe(true);
    expect((e.searchTokens as string[]).length).toBeGreaterThan(0);
    expect(typeof e.searchText).toBe("string");
    expect(typeof e.displayName).toBe("string");
  });

  it("the tokens carry what a person would search: player, product, number, variation", () => {
    const e = deriveCatalogEntry({ ...base, setName: "2018 Bowman Chrome" }) as never as { searchTokens: string[] };
    for (const t of ["shohei", "ohtani", "bowman", "chrome", "2018", "carrying", "bag", "variation", "sp"]) {
      expect(e.searchTokens, `missing token ${t}`).toContain(t);
    }
  });

  it("matches rebuildSearchFields EXACTLY — one derivation, not two", () => {
    for (const parallel of ["Base", "Carrying Bag Image Variation SP", "Gold Refractor"]) {
      const e = deriveCatalogEntry({ ...base, parallel, setName: "2018 Bowman Chrome" }) as never as {
        searchText: string; searchTokens: string[]; displayName: string; parallelSlug: string;
      };
      const healed = rebuildSearchFields({
        sport: "baseball", year: 2018, setKey: "bowman-chrome", setName: "2018 Bowman Chrome",
        cardNumber: "1", playerName: "Shohei Ohtani", parallel,
        parallelSlug: e.parallelSlug, printRun: null, subsetName: null,
      });
      expect(e.searchText, parallel).toBe(healed.searchText);
      expect(e.searchTokens, parallel).toEqual(healed.searchTokens);
      expect(e.displayName, parallel).toBe(healed.displayName);
    }
  });

  it("still findable with NO setName — the fields are built from the setKey", () => {
    const e = deriveCatalogEntry(base) as never as { searchTokens: string[]; displayName: string };
    expect(e.searchTokens.length).toBeGreaterThan(0);
    for (const t of ["shohei", "ohtani", "bowman", "chrome"]) expect(e.searchTokens).toContain(t);
    expect(e.displayName).toBeTruthy();
  });

  it("setName is written only when the source gave one", () => {
    const withName = deriveCatalogEntry({ ...base, setName: "2018 Bowman Chrome" }) as never as Record<string, unknown>;
    const without = deriveCatalogEntry(base) as never as Record<string, unknown>;
    expect(withName.setName).toBe("2018 Bowman Chrome");
    expect("setName" in without).toBe(false);
  });

  it("a blank setName is not written as an empty string", () => {
    const e = deriveCatalogEntry({ ...base, setName: "   " }) as never as Record<string, unknown>;
    expect("setName" in e).toBe(false);
  });

  it("the refusal contract is unchanged — a row with no player is still null", () => {
    expect(deriveCatalogEntry({ ...base, playerName: "" })).toBeNull();
    expect(deriveCatalogEntry({ ...base, cardNumber: "" })).toBeNull();
  });
});
