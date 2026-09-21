/**
 * CF-SCOPED-MARKET-LANGUAGE (Drew, 2026-09-21). Owner ruling: "Blue Sapphire
 * is just a Sapphire base term" -- Sapphire products are blue by design, so
 * a sale calling itself "Blue Sapphire" / "Sapphire Blue" / "Blue Sapphire
 * Refractor" on a product whose checklist states NO separate Blue rung is
 * the BASE card, settled from the published checklists per product-year:
 *
 *   baseball bowman-draft-sapphire        2024, 2025
 *   baseball bowman-chrome-sapphire       2024, 2025, 2026
 *   baseball topps-chrome-sapphire        2019, 2020, 2025
 *   baseball topps-chrome-update-sapphire 2024, 2025
 *
 * Same (sport, year, setKey)-scoped, additive-only shape as
 * SCOPED_AUTO_PREFIX -- a miss (unscoped call, unlisted year, unlisted
 * product, or a phrase this table does not name) changes NOTHING.
 *
 * EXPLICITLY EXCLUDED: 2019 bowman-draft-sapphire. Its checklist (source:
 * cardboardconnection.com's 2019 Bowman Draft Sapphire Edition guide) states
 * a REAL, distinct, numbered "Blue /99" rung beside Gold/Red/Green/Orange/
 * Black/Padparadscha Sapphire -- confirmed against card_catalog (200
 * baseballcardpedia-ladders-2026-09-02 rows, all cardYear 2019, all
 * printRun 99, e.g. hiq:baseball:2019:bowman-draft-sapphire:bdc-9:base:
 * no-auto ALSO carries a SEPARATE bdc-9:blue-sapphire:no-auto:num-99 row).
 * Aliasing this year would merge a genuine numbered rung's sales into the
 * raw base pool -- exactly the "one card, one row, one pool" violation in
 * the wrong direction. See the pin below.
 *
 * A stated print run is NEVER dropped by this alias -- it renames the
 * PARALLEL text only; computeHobbyIqCardId's `:num-N` slot is independent.
 */
import { describe, it, expect } from "vitest";
import {
  parseListingIdentity,
  scopedMarketLanguageAlias,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { rederiveRow } from "../src/services/portfolioiq/slugRederivation.service.js";

describe("scopedMarketLanguageAlias — additive, (sport, year, setKey)-scoped", () => {
  it("unscoped call: returns null, changes nothing", () => {
    expect(scopedMarketLanguageAlias("Blue Sapphire", null)).toBeNull();
    expect(scopedMarketLanguageAlias("Blue Sapphire")).toBeNull();
  });

  it("every listed product-year aliases 'Blue Sapphire' / 'Sapphire Blue' / 'Blue Sapphire Refractor' to Base", () => {
    const scopes: Array<{ sport: string; year: number; setKey: string }> = [
      { sport: "baseball", year: 2024, setKey: "bowman-draft-sapphire" },
      { sport: "baseball", year: 2025, setKey: "bowman-draft-sapphire" },
      { sport: "baseball", year: 2024, setKey: "bowman-chrome-sapphire" },
      { sport: "baseball", year: 2025, setKey: "bowman-chrome-sapphire" },
      { sport: "baseball", year: 2026, setKey: "bowman-chrome-sapphire" },
      { sport: "baseball", year: 2019, setKey: "topps-chrome-sapphire" },
      { sport: "baseball", year: 2020, setKey: "topps-chrome-sapphire" },
      { sport: "baseball", year: 2025, setKey: "topps-chrome-sapphire" },
      { sport: "baseball", year: 2024, setKey: "topps-chrome-update-sapphire" },
      { sport: "baseball", year: 2025, setKey: "topps-chrome-update-sapphire" },
    ];
    for (const scope of scopes) {
      expect(scopedMarketLanguageAlias("Blue Sapphire", scope), JSON.stringify(scope)).toBe("Base");
      expect(scopedMarketLanguageAlias("Sapphire Blue", scope), JSON.stringify(scope)).toBe("Base");
      expect(scopedMarketLanguageAlias("Blue Sapphire Refractor", scope), JSON.stringify(scope)).toBe("Base");
      // case/whitespace-insensitive, matching the parser's own convention
      expect(scopedMarketLanguageAlias("  blue   sapphire ", scope), JSON.stringify(scope)).toBe("Base");
    }
  });

  it("PINNED: 2019 bowman-draft-sapphire is EXPLICITLY excluded -- Blue Sapphire stays distinct", () => {
    const scope = { sport: "baseball", year: 2019, setKey: "bowman-draft-sapphire" };
    expect(scopedMarketLanguageAlias("Blue Sapphire", scope)).toBeNull();
    expect(scopedMarketLanguageAlias("Sapphire Blue", scope)).toBeNull();
    expect(scopedMarketLanguageAlias("Blue Sapphire Refractor", scope)).toBeNull();
  });

  it("PINNED: an unlisted year on a listed product changes nothing", () => {
    for (const year of [2018, 2020, 2021, 2022, 2023, 2027]) {
      expect(scopedMarketLanguageAlias("Blue Sapphire", { sport: "baseball", year, setKey: "bowman-draft-sapphire" })).toBeNull();
    }
    // topps-chrome-sapphire's own gaps (2021-2024 are not in the table).
    for (const year of [2021, 2022, 2023, 2024]) {
      expect(scopedMarketLanguageAlias("Blue Sapphire", { sport: "baseball", year, setKey: "topps-chrome-sapphire" })).toBeNull();
    }
  });

  it("PINNED: an unlisted product never aliases, even in a listed year", () => {
    expect(scopedMarketLanguageAlias("Blue Sapphire", { sport: "baseball", year: 2025, setKey: "topps-chrome" })).toBeNull();
    expect(scopedMarketLanguageAlias("Blue Sapphire", { sport: "baseball", year: 2025, setKey: "bowman-sapphire" })).toBeNull();
    expect(scopedMarketLanguageAlias("Blue Sapphire", { sport: "football", year: 2025, setKey: "bowman-draft-sapphire" })).toBeNull();
  });

  it("a phrase this table does not name is untouched, even in scope", () => {
    const scope = { sport: "baseball", year: 2025, setKey: "bowman-draft-sapphire" };
    expect(scopedMarketLanguageAlias("Gold Sapphire", scope)).toBeNull();
    expect(scopedMarketLanguageAlias("Red Sapphire", scope)).toBeNull();
    expect(scopedMarketLanguageAlias("Padparadscha Sapphire", scope)).toBeNull();
    expect(scopedMarketLanguageAlias("Sapphire", scope)).toBeNull();
    expect(scopedMarketLanguageAlias("Base", scope)).toBeNull();
  });

  it("missing scope fields never throw and read null", () => {
    expect(scopedMarketLanguageAlias("Blue Sapphire", {})).toBeNull();
    expect(scopedMarketLanguageAlias("Blue Sapphire", { sport: "baseball" })).toBeNull();
    expect(scopedMarketLanguageAlias(null, { sport: "baseball", year: 2025, setKey: "bowman-draft-sapphire" })).toBeNull();
  });
});

describe("END-TO-END: real titles through parseListingIdentity + the write door (rederiveRow)", () => {
  it("2025 Bowman Draft Sapphire #BDC-12 Blue Sapphire -> base, only when scoped", () => {
    const title = "2025 Bowman Draft Sapphire Baseball #BDC-12 Blue Sapphire";
    // parseListingIdentity alone still reads the title's own words.
    expect(parseListingIdentity(title).parallel).toBe("Blue Sapphire");
  });

  it("written hobbyiqCardId via rederiveRow ends up on the BASE row for a listed product-year", () => {
    const r = rederiveRow({
      sport: null, // fails the current-fields guard -> forces the title-consult / rederive branch
      cardYear: 2025,
      setName: "Bowman Draft Sapphire",
      cardNumber: "BDC-12",
      parallel: "Blue Sapphire",
      isAuto: false,
      title: "2025 Bowman Draft Sapphire Baseball #BDC-12 Blue Sapphire",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).toBe("Base");
    expect(r.hobbyiqCardId).toBe("hiq:baseball:2025:bowman-draft-sapphire:bdc-12:base:no-auto");
  });

  it("a stated print run survives the alias -- renames the parallel only, never drops :num-N", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2025,
      setName: "Bowman Chrome Sapphire",
      cardNumber: "BCP-1",
      parallel: "Blue Sapphire",
      isAuto: false,
      title: "2025 Bowman Chrome Sapphire Baseball #BCP-1 Blue Sapphire /150",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).toBe("Base");
    expect(r.hobbyiqCardId).toMatch(/:base:no-auto:num-150$/);
  });

  it("PINNED end-to-end: 2019 Bowman Draft Sapphire Blue Sapphire stays its OWN rung, not base", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2019,
      setName: "Bowman Draft Sapphire",
      cardNumber: "BDC-9",
      parallel: "Blue Sapphire",
      isAuto: false,
      title: "2019 Bowman Draft Sapphire Baseball #BDC-9 Blue Sapphire /99",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).toBe("Blue Sapphire");
    expect(r.hobbyiqCardId).not.toMatch(/:base:/);
    expect(r.hobbyiqCardId).toMatch(/:blue-sapphire:.*:num-99$/);
  });

  it("a non-Sapphire product with a real 'Blue' rung is untouched", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2025,
      setName: "Bowman Chrome",
      cardNumber: "BCP-1",
      parallel: "Blue Refractor",
      isAuto: false,
      title: "2025 Bowman Chrome Baseball #BCP-1 Blue Refractor",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).toBe("Blue Refractor");
    expect(r.hobbyiqCardId).not.toMatch(/:base:/);
  });

  it("'Gold Sapphire' on a listed Sapphire product-year is NEVER aliased to Base (not a phrase this table names)", () => {
    // Note: the title-level "Gold" -> chrome-implied "Gold Refractor" rule
    // (pre-existing, unrelated to this PR) fires upstream of the alias --
    // the load-bearing assertion here is that scopedMarketLanguageAlias
    // itself never turns a NAMED Sapphire colour rung into Base, regardless
    // of exactly which spelling the rest of the parser lands on.
    const r = rederiveRow({
      sport: null,
      cardYear: 2025,
      setName: "Bowman Draft Sapphire",
      cardNumber: "BDC-12",
      parallel: "Gold Sapphire",
      isAuto: false,
      title: "2025 Bowman Draft Sapphire Baseball #BDC-12 Gold Sapphire",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).not.toBe("Base");
  });
});
