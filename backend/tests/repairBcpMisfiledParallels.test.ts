/**
 * D33 -- repair-bcp-misfiled-parallels, the five modes behind Drew's "still a
 * mess" on 2020 Bowman Draft BD-152 (2026-08-30).
 *
 * Each mode is a pure decision plus a Cosmos walk; these tests pin the
 * decisions, which is where every one of the five defects lives. The fixtures
 * are rows measured read-only from card_catalog on 2026-08-30, not invented
 * shapes.
 *
 * The load-bearing test in this file is the player gate. A move from BD-N to
 * BDC-N is only safe when both numbers name the same player, and naive string
 * equality called 132 of 1,091 measured pairs a mismatch when every one was
 * spelling noise. A gate that refuses 132 good moves is exactly as wrong as a
 * gate that allows one bad one, so both directions are pinned.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../scripts/repair-bcp-misfiled-parallels.cjs");
const {
  MODES, isCardAsParallel, chromeNumberOf, chromeLadderClass,
  foldPlayer, samePlayer, firstEditionTarget, gluedTarget,
  identityParts, rebuildId, reconcile, querySpec, setKeyDisagrees,
} = mod;

describe("MODE=card-as-parallel -- the page's card list is not the parallel column", () => {
  const bcp = (parallelSlug: string, source = "baseballcardpedia") => ({ parallelSlug, source });

  it.each([
    "bd-121-spencer-torkelson",
    "bd-152-bobby-witt-jr",
    "bd-154-adley-rutschman",
    "bd-107-zac-veen",
    "bdc-152-bobby-witt",
    "bcp-66-jesus-made",
    "bp-41-eric-brown",
    "bdpp-12-someone-else",
    "cpa-3-angel-nunez",
  ])("matches the card-as-parallel shape %j", (slug) => {
    expect(isCardAsParallel(bcp(slug))).toBe(true);
  });

  it("covers the graded children too -- 18,491 of the 47,267 rows are theirs", () => {
    expect(isCardAsParallel(bcp("bd-121-spencer-torkelson", "baseballcardpedia-graded"))).toBe(true);
  });

  it.each([
    // Real rungs of these very products. None of these may ever be retired.
    "blue-refractor",
    "gold",
    "sky-blue",
    "superfractor",
    "padparadscha",
    "1st-edition-blue",
    "printing-plates",
    "black",
    "sapphire-edition",
    "base",
    // A bare card number with no name is a DIFFERENT defect, not this one.
    "bd-152",
    "bdc-152",
  ])("never matches the real rung %j", (slug) => {
    expect(isCardAsParallel(bcp(slug))).toBe(false);
  });

  it("is scoped to the bcp sources -- another source's row with the same shape is not ours", () => {
    expect(isCardAsParallel(bcp("bd-121-spencer-torkelson", "checklistcenter-2026-08-29"))).toBe(false);
    expect(isCardAsParallel(bcp("bd-121-spencer-torkelson", "beckett"))).toBe(false);
  });

  it("tolerates a row with no parallelSlug at all", () => {
    expect(isCardAsParallel({ source: "baseballcardpedia" })).toBe(false);
    expect(isCardAsParallel(null)).toBe(false);
  });
});

describe("MODE=chrome-ladder -- the refractor ladder belongs to the chrome number", () => {
  it("maps a paper number to its chrome twin, and only a paper number", () => {
    expect(chromeNumberOf("BD-152")).toBe("BDC-152");
    expect(chromeNumberOf("BP-41")).toBe("BCP-41");
    expect(chromeNumberOf("bd-152")).toBe("BDC-152");
    // Already chrome, or not a Bowman paper number: no mapping, so no move.
    expect(chromeNumberOf("BDC-152")).toBeNull();
    expect(chromeNumberOf("BCP-66")).toBeNull();
    expect(chromeNumberOf("US150")).toBeNull();
    expect(chromeNumberOf(null)).toBeNull();
  });

  it.each([
    ["blue-refractor", "refractor"],
    ["gold-refractor", "refractor"],
    ["green-refractor", "refractor"],
    ["superfractor", "refractor"],
    ["blue-wave", "refractor"],
    ["gold-wave", "refractor"],
    ["sparkle-refractor", "refractor"],
    ["pulsar-refractor", "refractor"],
    // Sapphire is its own product under D23 -- classified apart so the mode
    // REPORTS it instead of moving it to a chrome number it does not belong to.
    ["aqua-sapphire", "sapphire"],
    ["gold-sapphire", "sapphire"],
    ["sapphire-edition", "sapphire"],
    ["padparadscha", "sapphire"],
  ])("classifies %j as the %s ladder", (slug, want) => {
    expect(chromeLadderClass({ parallelSlug: slug })).toBe(want);
  });

  it.each([
    // The PAPER border ladder, which is right where it is and must not move.
    "blue", "gold", "green", "orange", "purple", "red", "sky-blue", "black", "printing-plates", "base",
  ])("leaves the paper rung %j unclassified, so it never moves", (slug) => {
    expect(chromeLadderClass({ parallelSlug: slug })).toBeNull();
  });

  it("D31: a colour and its refractor are two cards, and only the refractor travels", () => {
    // "Blue /150" (paper, BD-152) and "Blue Refractor /150" (chrome, BDC-152)
    // are different cards. The bare colour stays; the refractor moves.
    expect(chromeLadderClass({ parallelSlug: "blue" })).toBeNull();
    expect(chromeLadderClass({ parallelSlug: "blue-refractor" })).toBe("refractor");
  });

  it("builds the chrome slug by replacing ONLY the card-number segment", () => {
    const id = "hiq:baseball:2020:bowman-draft:bd-152:blue-refractor:no-auto:num-150";
    const parts = identityParts(id);
    expect(rebuildId(parts, { cardNumber: "bdc-152" }))
      .toBe("hiq:baseball:2020:bowman-draft:bdc-152:blue-refractor:no-auto:num-150");
  });
});

describe("the player gate -- 132 of 1,091 measured pairs were spelling noise, not conflicts", () => {
  it.each([
    // Diacritics. The brief's 14 of 15 "mismatches".
    ["Jesus Sanchez", "Jesús Sánchez"],
    ["Oscar Colas", "Óscar Colás"],
    ["Wilmer Dominguez", "Wilmer Domínguez"],
    ["Lazaro Estrada", "Lázaro Estrada"],
    // The comma suffix this same PR fixes in cleanPlayerName.
    ["Robby Martin, Jr.", "Robby Martin Jr."],
    ["Bobby Witt, Jr.", "Bobby Witt Jr."],
    // A scraped "1st" glued to the name by the checklist source.
    ["Jhonkensy Noel 1st", "Jhonkensy Noel"],
    ["Curtis Mead 1st", "Curtis Mead"],
    // A suffix present on one side only -- one player, two spellings.
    ["Bobby Witt", "Bobby Witt Jr."],
    ["Vladimir Guerrero", "Vladimir Guerrero Jr."],
    ["Enrique Bradfield", "Enrique Bradfield Jr."],
    ["Victor Mesa", "Victor Mesa Jr."],
  ])("folds %j and %j to the same player, so the move proceeds", (a, b) => {
    expect(samePlayer(a, b)).toBe(true);
    expect(samePlayer(b, a)).toBe(true);
  });

  it.each([
    // Genuinely different people. These must refuse.
    ["Jesus Made", "Sammy Hernandez"],
    ["Spencer Torkelson", "Adley Rutschman"],
    ["Angel Nunez", "Alejandro Nunez"],
    ["Bobby Witt", "Bobby Miller"],
  ])("refuses %j against %j, so the row is reported instead of merged", (a, b) => {
    expect(samePlayer(a, b)).toBe(false);
  });

  it("an unknown name is not equality -- a blank never satisfies the gate", () => {
    expect(samePlayer("", "Bobby Witt Jr.")).toBe(false);
    expect(samePlayer(null, "Bobby Witt Jr.")).toBe(false);
    expect(samePlayer("Bobby Witt Jr.", undefined)).toBe(false);
  });

  it("MUTATION CHECK: naive equality would refuse every one of the folded pairs", () => {
    // If foldPlayer stopped folding, this test would be the one that notices.
    const naive = (a: string, b: string) => String(a).toLowerCase() === String(b).toLowerCase();
    const pairs: Array<[string, string]> = [
      ["Jesus Sanchez", "Jesús Sánchez"],
      ["Robby Martin, Jr.", "Robby Martin Jr."],
      ["Jhonkensy Noel 1st", "Jhonkensy Noel"],
      ["Bobby Witt", "Bobby Witt Jr."],
    ];
    for (const [a, b] of pairs) {
      expect(naive(a, b)).toBe(false);   // the gate that would lose good moves
      expect(samePlayer(a, b)).toBe(true);
    }
    // And the one real conflict is still refused by BOTH.
    expect(naive("Jesus Made", "Sammy Hernandez")).toBe(false);
    expect(samePlayer("Jesus Made", "Sammy Hernandez")).toBe(false);
  });

  it("foldPlayer is stable and idempotent", () => {
    expect(foldPlayer(foldPlayer("Ronald Acuña, Jr."))).toBe(foldPlayer("Ronald Acuña, Jr."));
    expect(foldPlayer("Ronald Acuña, Jr.")).toBe("ronald acuna jr");
  });
});

describe("MODE=first-edition -- 1st Edition is its own product (D23)", () => {
  const row = (setKey: string, parallelSlug: string, parallel: string, sport = "baseball") =>
    ({ sport, setKey, parallelSlug, parallel });

  it("routes bowman-draft to bowman-draft-1st-edition and strips the prefix", () => {
    expect(firstEditionTarget(row("bowman-draft", "1st-edition-blue", "1st Edition Blue")))
      .toEqual({ product: "bowman-draft-1st-edition", parallelSlug: "blue", parallel: "Blue" });
  });

  it("routes bowman to bowman-1st-edition", () => {
    expect(firstEditionTarget(row("bowman", "1st-edition-gold", "1st Edition Gold")))
      .toEqual({ product: "bowman-1st-edition", parallelSlug: "gold", parallel: "Gold" });
  });

  it("keeps a multi-word parallel intact", () => {
    expect(firstEditionTarget(row("bowman-draft", "1st-edition-sky-blue", "1st Edition Sky Blue")))
      .toEqual({ product: "bowman-draft-1st-edition", parallelSlug: "sky-blue", parallel: "Sky Blue" });
  });

  it("REFUSES Pokemon -- '1st Edition Prerelease' is a PRINT, not a product", () => {
    // ~90 rows sit under base1 / base2 / fossil setKeys with exactly this slug
    // shape. Moving them to a Bowman product would be catastrophic nonsense.
    expect(firstEditionTarget({ sport: "pokemon", setKey: "base1", parallelSlug: "1st-edition-red-cheeks", parallel: "1st Edition Red Cheeks" })).toBeNull();
    expect(firstEditionTarget({ sport: "pokemon", setKey: "1999-pokemon-fossil", parallelSlug: "1st-edition-prerelease", parallel: "1st Edition Prerelease" })).toBeNull();
    expect(firstEditionTarget({ sport: "pokemon", setKey: "base2", parallelSlug: "1st-edition-w-stamp-duelist-promo", parallel: "1st Edition W Stamp Duelist Promo" })).toBeNull();
  });

  it("refuses a product the ruling does not name", () => {
    expect(firstEditionTarget(row("topps-chrome", "1st-edition-blue", "1st Edition Blue"))).toBeNull();
    expect(firstEditionTarget(row("bowman-chrome", "1st-edition-blue", "1st Edition Blue"))).toBeNull();
  });

  it("refuses a row that is already at the 1st Edition product", () => {
    expect(firstEditionTarget(row("bowman-1st-edition", "1st-edition-blue", "1st Edition Blue"))).toBeNull();
  });

  it("refuses a bare '1st-edition' with nothing after it -- there is no parallel to keep", () => {
    expect(firstEditionTarget(row("bowman-draft", "1st-edition-", "1st Edition"))).toBeNull();
    expect(firstEditionTarget(row("bowman-draft", "1st-edition", "1st Edition"))).toBeNull();
  });

  it("moves the product segment of the id, keeping number and parallel coherent", () => {
    const parts = identityParts("hiq:baseball:2020:bowman-draft:bd-152:1st-edition-blue:no-auto:num-150");
    expect(rebuildId(parts, { setKey: "bowman-draft-1st-edition", parallelSlug: "blue" }))
      .toBe("hiq:baseball:2020:bowman-draft-1st-edition:bd-152:blue:no-auto:num-150");
  });
});

describe("MODE=number-glued -- the 1/1 was swallowed into the parallel name", () => {
  it.each([
    ["black-1", "black"],
    ["superfractor-1", "superfractor"],
    ["superfractor-1-refractor", "superfractor"],
  ])("%j folds to %j at /1", (slug, want) => {
    expect(gluedTarget({ parallelSlug: slug })).toEqual({ parallelSlug: want, printRun: 1 });
  });

  it.each([
    // The real numbered rows -- the fold TARGETS, which must never themselves move.
    "black", "superfractor", "blue-refractor", "gold",
    // Numbers that are not the 1/1 glue shape.
    "black-2", "gold-50", "purple-250",
  ])("leaves %j alone", (slug) => {
    expect(gluedTarget({ parallelSlug: slug })).toBeNull();
  });

  it("builds the numbered slug, adding the num- segment when the row had none", () => {
    const parts = identityParts("hiq:baseball:2020:bowman-draft:bd-152:black-1:no-auto");
    expect(rebuildId(parts, { parallelSlug: "black", printRun: 1 }))
      .toBe("hiq:baseball:2020:bowman-draft:bd-152:black:no-auto:num-1");
  });

  it("is multi-sport by construction -- football and basketball rows carry the same slugs", () => {
    // 18,263 of the 20,031 rows come from checklistcenter across three sports;
    // a bowman-only filter would have missed most of them.
    expect(gluedTarget({ parallelSlug: "black-1", sport: "football", setKey: "panini-phoenix" })).toEqual({ parallelSlug: "black", printRun: 1 });
    expect(gluedTarget({ parallelSlug: "superfractor-1", sport: "basketball", setKey: "topps-finest" })).toEqual({ parallelSlug: "superfractor", printRun: 1 });
  });
});

describe("identityParts / rebuildId", () => {
  it("reads a 7-segment and an 8-segment identity", () => {
    expect(identityParts("hiq:baseball:2020:bowman-draft:bd-152:blue:no-auto")).toHaveLength(7);
    expect(identityParts("hiq:baseball:2020:bowman-draft:bd-152:blue:no-auto:num-150")).toHaveLength(8);
  });

  it("refuses a graded child and anything that is not an hiq slug", () => {
    expect(identityParts("hiq:baseball:2020:bowman-draft:bd-152:blue:no-auto:psa-10")).toBeNull();
    expect(identityParts("ch:12345")).toBeNull();
    expect(identityParts("")).toBeNull();
    expect(identityParts(null)).toBeNull();
  });

  it("drops the print-run segment when asked for null", () => {
    const parts = identityParts("hiq:baseball:2020:bowman-draft:bd-152:blue:no-auto:num-150");
    expect(rebuildId(parts, { printRun: null })).toBe("hiq:baseball:2020:bowman-draft:bd-152:blue:no-auto");
  });
});

describe("the run's contract: modes, scope and reconciliation", () => {
  it("names exactly the five modes", () => {
    expect(MODES).toEqual(["card-as-parallel", "chrome-ladder", "first-edition", "names", "number-glued"]);
  });

  it("every mode has a query, and an unknown mode throws rather than defaulting", () => {
    for (const m of MODES) expect(querySpec(m).query).toContain("FROM c");
    expect(() => querySpec("something-else")).toThrow(/unknown MODE/);
  });

  it("MODE=first-edition is scoped to baseball Bowman in SQL, not only in the decision", () => {
    // Belt and braces: the Pokemon rows must not even be fetched.
    const q = querySpec("first-edition").query;
    expect(q).toContain('c.setKey IN ("bowman","bowman-draft")');
    expect(q).toContain('LOWER(c.sport) = "baseball"');
  });

  it("MODE=chrome-ladder reads only PAPER numbers, so a chrome row is never re-moved", () => {
    const q = querySpec("chrome-ladder").query;
    expect(q).toContain('STARTSWITH(c.cardNumber,"BD-")');
    expect(q).toContain('STARTSWITH(c.cardNumber,"BP-")');
    expect(q).not.toContain('STARTSWITH(c.cardNumber,"BDC-")');
  });

  it("MODE=card-as-parallel reads only the bcp sources", () => {
    expect(querySpec("card-as-parallel").query).toContain('STARTSWITH(c.source, "baseballcardpedia")');
  });

  it("the rows examined partition into exactly one path each", () => {
    const rec = reconcile("t", { candidates: 100, written: 60, skipped: 35, failed: 5, notReached: 0 });
    expect(rec.balances).toBe(true);
    expect(rec.written + rec.skipped + rec.failed).toBe(rec.candidates);
  });

  it("notReached is a SIBLING of candidates, not a slice of it", () => {
    // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER. A budget stop leaves rows this slot
    // owned but never examined; folding them into the examined sum would
    // double-count and make a correct run look broken.
    const rec = reconcile("t", { candidates: 100, written: 60, skipped: 35, failed: 5, notReached: 116 });
    expect(rec.balances).toBe(true);              // the examined rows still close
    expect(rec.intended).toBe(216);               // the slot owned 216 in total
    expect(rec.accountsForAll).toBe(true);
  });

  it("notices when the examined rows do NOT partition", () => {
    expect(reconcile("t", { candidates: 100, written: 60, skipped: 30, failed: 5, notReached: 0 }).balances).toBe(false);
  });

  it("reportWrites gets intended = examined + notReached, and skipped absorbs notReached", () => {
    const rec = reconcile("t", { candidates: 10, written: 4, skipped: 5, failed: 1, notReached: 2 });
    expect(rec.intended).toBe(12);
    expect(rec.written + (rec.skipped + rec.notReached) + rec.failed).toBe(rec.intended);
  });
});

describe("a row whose id and field disagree about the product is D23's, not this pass's", () => {
  // Found by the MODE=chrome-ladder dry run on 2026-08-30: 262 of 864
  // candidates failed inside catalogRowOps with "a key needs both halves",
  // because the id segment read `bowman-paper` while the setKey FIELD said
  // `bowman`. Which half is the card is a question the D23 rename fleet
  // answers; guessing here would move a row to a product on a coin flip.
  it("spots the split", () => {
    const parts = identityParts("hiq:baseball:2022:bowman-paper:bp-53:refractor:no-auto:num-499");
    expect(setKeyDisagrees({ setKey: "bowman" }, parts)).toBe(true);
  });

  it("passes a row whose halves agree", () => {
    const parts = identityParts("hiq:baseball:2020:bowman-draft:bd-152:blue-refractor:no-auto:num-150");
    expect(setKeyDisagrees({ setKey: "bowman-draft" }, parts)).toBe(false);
    expect(setKeyDisagrees({ setKey: "Bowman-Draft" }, parts)).toBe(false);
  });

  it("a missing field is not a disagreement -- there is nothing to disagree with", () => {
    const parts = identityParts("hiq:baseball:2020:bowman-draft:bd-152:blue:no-auto");
    expect(setKeyDisagrees({}, parts)).toBe(false);
    expect(setKeyDisagrees({ setKey: null }, parts)).toBe(false);
  });
});
