/**
 * CF-SCOPED-MARKET-LANGUAGE (Drew, 2026-09-21). Owner ruling: "Blue Sapphire
 * is just a Sapphire base term" -- Sapphire products are blue by design, so
 * a sale calling itself "Blue Sapphire" / "Sapphire Blue" / "Blue Sapphire
 * Refractor" on a product whose checklist states NO separate Blue rung is
 * the BASE card, settled from the published checklists per product-year:
 *
 *   baseball bowman-draft-sapphire        2024, 2025
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
 * EXPLICITLY EXCLUDED (review round 3, 2026-09-21): ALL of
 * bowman-chrome-sapphire 2024/2025/2026, DROPPED after round 2. The 66/66
 * (2024) and 65/65-with-printRun (2025) "Blue Sapphire" catalog rows for
 * this product are ALL checklist-grade (beckett-checklist /
 * beckett-checklist-graded), all printRun 150, and the same card number
 * carries a SEPARATE "Base" row (e.g. SSA-JP has both `ssa-jp:base:auto`
 * and `ssa-jp:blue-sapphire:auto:num-150`) -- two distinct priced cards.
 * Round 2 wrongly dismissed these as mislabeled base autos. 2026 has zero
 * catalog rows either way and is dropped along with its siblings since the
 * SAME product's other two years both prove a real rung.
 *
 * A stated print run is NEVER dropped by this alias -- it renames the
 * PARALLEL text only; computeHobbyIqCardId's `:num-N` slot is independent.
 *
 * COMPANION FIX (review round 3): extractParallel's Sapphire-block bare
 * `\bblue\b` check (and the earlier adjacent `blue\s+sapphire` regex) used
 * to fire on ANY title containing the word "blue", including a compound
 * colour ("Sky Blue", "Royal Blue", "Navy Blue", "Aqua Blue", "Ice Blue",
 * "Baby Blue", "Teal Blue", "Dark Blue", "Light Blue") that is a DIFFERENT
 * card from bare "Blue Sapphire" -- so a genuinely different colour folded
 * down to "Blue Sapphire" and then got aliased to Base by this very PR.
 * Real failing title: "2025 Bowman Draft #BDC-128 Jake Munroe Chrome Sky
 * Blue Refractor Sapphire". Fixed with a qualifier guard, refusing rather
 * than guessing, same shape as the file's other compound-colour checks.
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

  it("PINNED (review round 3): bowman-chrome-sapphire is EXPLICITLY excluded in every year -- Beckett proves a distinct rung", () => {
    for (const year of [2024, 2025, 2026]) {
      const scope = { sport: "baseball", year, setKey: "bowman-chrome-sapphire" };
      expect(scopedMarketLanguageAlias("Blue Sapphire", scope), JSON.stringify(scope)).toBeNull();
      expect(scopedMarketLanguageAlias("Sapphire Blue", scope), JSON.stringify(scope)).toBeNull();
      expect(scopedMarketLanguageAlias("Blue Sapphire Refractor", scope), JSON.stringify(scope)).toBeNull();
    }
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
      setName: "Topps Chrome Update Sapphire",
      cardNumber: "USC178",
      parallel: "Blue Sapphire",
      isAuto: false,
      title: "2025 Topps Chrome Update Sapphire Baseball #USC178 Blue Sapphire /199",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).toBe("Base");
    expect(r.hobbyiqCardId).toMatch(/:base:no-auto:num-199$/);
  });

  it("PINNED (review round 3): bowman-chrome-sapphire Blue Sapphire stays its OWN rung end-to-end, not base", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2024,
      setName: "Bowman Chrome Sapphire",
      cardNumber: "SSA-JP",
      parallel: "Blue Sapphire",
      isAuto: true,
      title: "2024 Bowman Chrome Sapphire Baseball #SSA-JP Blue Sapphire Auto /150",
    });
    expect(r.action).toBe("rederived");
    expect(r.parallel).toBe("Blue Sapphire");
    expect(r.hobbyiqCardId).not.toMatch(/:base:/);
    expect(r.hobbyiqCardId).toMatch(/:blue-sapphire:.*:num-150$/);
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

describe("COMPANION FIX (review round 3): a QUALIFIED blue is never read as bare 'Blue Sapphire'", () => {
  it("the real failing title never parses to Blue Sapphire, and is never aliased to Base", () => {
    const title = "2025 Bowman Draft #BDC-128 Jake Munroe Chrome Sky Blue Refractor Sapphire";
    const parsed = parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "bowman-draft-sapphire" });
    expect(parsed.parallel).not.toBe("Blue Sapphire");
    expect(parsed.parallel).not.toBe("Base");
  });

  it("PINNED end-to-end: the real failing title through rederiveRow never lands on :base:", () => {
    const r = rederiveRow({
      sport: null,
      cardYear: 2025,
      setName: "Bowman Draft Sapphire",
      cardNumber: "BDC-128",
      parallel: "Blue Sapphire", // the stored field before this fix's own upstream repair
      isAuto: false,
      title: "2025 Bowman Draft Baseball #BDC-128 Jake Munroe Chrome Sky Blue Refractor Sapphire",
    });
    expect(r.action).toBe("rederived");
    // The title is the evidence and wins over the stored field's stale "Blue
    // Sapphire" -- it must read as the compound colour, never Base.
    expect(r.parallel).not.toBe("Blue Sapphire");
    expect(r.parallel).not.toBe("Base");
    expect(r.hobbyiqCardId).not.toMatch(/:base:/);
  });

  it.each([
    ["Sky Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Sky Blue Sapphire"],
    ["Light Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Light Blue Sapphire"],
    ["Aqua Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Aqua Blue Sapphire"],
    ["Navy Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Navy Blue Sapphire"],
    ["Royal Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Royal Blue Sapphire"],
    ["Ice Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Ice Blue Sapphire"],
    ["Baby Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Baby Blue Sapphire"],
    ["Teal Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Teal Blue Sapphire"],
    ["Dark Blue", "2025 Bowman Draft Sapphire Baseball #BDC-12 Dark Blue Sapphire"],
  ])("%s Sapphire never reads as bare 'Blue Sapphire', so the alias can never fire on it", (_label, title) => {
    // The load-bearing property: the qualified colour must never fold down to
    // the exact phrase "Blue Sapphire" (that is what would let the alias
    // rewrite it to Base). Some of these qualifiers (aqua/baby/teal/dark)
    // are not colours the Sapphire block recognises AT ALL -- pre-existing,
    // unrelated to this fix -- and fall through to the generic "Base"
    // fallback on their own; that is a separate colour-coverage gap, not
    // the compound-blue-collapse defect this fix targets, so it is not
    // asserted against here. What IS asserted: the OUTPUT is never the
    // exact string this table's alias matches, so scopedMarketLanguageAlias
    // itself never has anything to act on for these titles.
    const scope = { vertical: "baseball", year: 2025, setKey: "bowman-draft-sapphire" };
    const parsed = parseListingIdentity(title, undefined, scope);
    expect(parsed.parallel, title).not.toBe("Blue Sapphire");
    expect(
      scopedMarketLanguageAlias(parsed.parallel, { sport: "baseball", year: 2025, setKey: "bowman-draft-sapphire" }),
      title,
    ).toBeNull();
  });

  it("plain 'Blue Sapphire' (no qualifier) still parses and still aliases -- the guard is narrow", () => {
    const title = "2025 Bowman Draft Sapphire Baseball #BDC-12 Blue Sapphire";
    const parsed = parseListingIdentity(title, undefined, { vertical: "baseball", year: 2025, setKey: "bowman-draft-sapphire" });
    expect(parsed.parallel).toBe("Blue Sapphire");
    expect(scopedMarketLanguageAlias(parsed.parallel, { sport: "baseball", year: 2025, setKey: "bowman-draft-sapphire" })).toBe("Base");
  });
});
