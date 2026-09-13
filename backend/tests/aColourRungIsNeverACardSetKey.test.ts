// CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY (R30 corollary, Drew 2026-09-13).
//
// THE DEFECT THIS ENDS. #2112 derives a named insert set's own card set key and
// refuses any file whose derived keys are not normalizeSetKey fixed points. Run
// over `acq-2026-09-13-cbc` it named 170 keys to register -- and 110 OF THEM
// WERE COLOUR RUNGS, not card sets:
//
//     panini-prizm-draft-picks-college-penmanship-prizms-gold
//     panini-spectra-aspiring-patch-autographs-neon-splatter
//     nba-hoops-hot-signatures-hyper-gold
//
// Registering those would split ONE POOL PER COLOUR -- `one card, one row, one
// pool` failing on a different axis from the collision #2112 fixed. The ruling
// is explicit: a named parallel is a distinct CARD, not a distinct SET.
//
// WHY THE EXISTING STRIP COULD NOT SEE IT. `categorySubsetSlug` strips a
// parallel off a category tail only when the ROW'S OWN `parallel` column states
// it. cardboardconnection ships ONE FILE PER RUNG with the colour folded into
// the manifest `subset` and the parallel column BLANK -- 166 of its 197
// subset-declaring files have `distinctParallels: 0`.
//
// THE RULE IS A MEASUREMENT, NOT A LEXICON. That is the whole point, and the
// negative tests below are the reason: a word list would fold "Gold Standard",
// "Black Gold" and "Red Zone" -- real products whose NAMES end in a colour word
// -- into siblings that do not exist.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const IS = require(path.join(here, "..", "scripts", "lib", "insert-set-key.cjs"));

type Row = { category: string; cardNumber: string; parallel: string; player: string; subsetName: string | null };

/** Rows as the cbc lane stages them: the subset in the MANIFEST, the parallel
 *  column blank. `sub` is the manifest's `subset` string. */
function rows(sub: string, roster: Array<[string, string]>, parallel = ""): Row[] {
  return roster.map(([cardNumber, player]) => ({
    category: "", cardNumber, parallel, player, subsetName: sub,
  }));
}

const ROSTER: Array<[string, string]> = [
  ["1", "Paolo Banchero"], ["2", "Chet Holmgren"], ["3", "Jabari Smith Jr."],
];

describe("a colour rung folds onto its root subset, with the colour on the parallel axis", () => {
  it("folds a manifest-stated colour when the rosters agree exactly", () => {
    const all = [
      ...rows("College Penmanship", ROSTER),
      ...rows("College Penmanship Prizms Gold", ROSTER),
    ];
    const fold = IS.rungFoldingFor(all);
    expect(fold.has("college-penmanship-prizms-gold")).toBe(true);
    const f = fold.get("college-penmanship-prizms-gold");
    expect(f.root).toBe("college-penmanship");
    // The SOURCE's own spelling, un-slugged -- never a name this module invents.
    expect(f.parallel).toBe("Prizms Gold");
    // The root itself is a card set and folds nowhere.
    expect(fold.has("college-penmanship")).toBe(false);
  });

  it("puts the rung on the ROOT's key and moves the colour to the parallel", () => {
    const all = [
      ...rows("College Penmanship", ROSTER),
      ...rows("College Penmanship Prizms Gold", ROSTER),
    ];
    const fold = IS.rungFoldingFor(all);
    const placed = IS.setKeyForRow({
      productSetKey: "panini-prizm-draft-picks",
      category: "", parallel: "", subsetName: "College Penmanship Prizms Gold",
      separate: new Set(["college-penmanship"]), foldRungs: fold,
    });
    expect(placed.setKey).toBe("panini-prizm-draft-picks-college-penmanship");
    expect(placed.rungParallel).toBe("Prizms Gold");
    expect(IS.parallelForRow({
      category: "", parallel: "", subsetName: "College Penmanship Prizms Gold", foldRungs: fold,
    })).toBe("Prizms Gold");
  });

  it("a rung of a rung is a SIBLING COLOUR and folds to the ultimate root", () => {
    // "Prizms Blue Ice" picks "Prizms Blue" as its nearest prefix, but Blue Ice
    // is a sibling colour of Blue, not a rung of it. Both are rungs of the base
    // subset, and the parallel keeps the source's FULL spelling.
    const all = [
      ...rows("College Penmanship", ROSTER),
      ...rows("College Penmanship Prizms Blue", ROSTER),
      ...rows("College Penmanship Prizms Blue Ice", ROSTER),
    ];
    const fold = IS.rungFoldingFor(all);
    expect(fold.get("college-penmanship-prizms-blue").root).toBe("college-penmanship");
    expect(fold.get("college-penmanship-prizms-blue-ice").root).toBe("college-penmanship");
    expect(fold.get("college-penmanship-prizms-blue-ice").parallel).toBe("Prizms Blue Ice");
  });

  it("the row's OWN parallel column always wins over a folded colour", () => {
    const all = [
      ...rows("College Penmanship", ROSTER),
      ...rows("College Penmanship Prizms Gold", ROSTER),
    ];
    const fold = IS.rungFoldingFor(all);
    // A file that states both is naming a rung of a rung; the column is the
    // more specific statement.
    expect(IS.parallelForRow({
      category: "", parallel: "Laundry Tag 1/1",
      subsetName: "College Penmanship Prizms Gold", foldRungs: fold,
    })).toBe("Laundry Tag 1/1");
  });
});

describe("a subset the rosters do NOT vouch for stays a card set", () => {
  it("refuses the fold when ONE card number names a different player", () => {
    // A rung reprints its root's roster. One disagreement means two sets --
    // Hot Signatures Rookies against Hot Signatures: 98 different players.
    const all = [
      ...rows("Hot Signatures", ROSTER),
      ...rows("Hot Signatures Rookies", [["1", "Someone Else"], ["2", "Chet Holmgren"], ["3", "Jabari Smith Jr."]]),
    ];
    const fold = IS.rungFoldingFor(all);
    expect(fold.has("hot-signatures-rookies")).toBe(false);
  });

  it("refuses the fold when the numbers are DISJOINT", () => {
    // Art Signatures Horizontal shares no number with Art Signatures, so the
    // rosters cannot vouch for each other and an all-absent overlap proves
    // nothing. The source publishes them as separate checklists: card sets.
    const all = [
      ...rows("Hoops Art Signatures", ROSTER),
      ...rows("Hoops Art Signatures Horizontal", [["10", "Anthony Edwards"], ["11", "LaMelo Ball"]]),
    ];
    const fold = IS.rungFoldingFor(all);
    expect(fold.has("hoops-art-signatures-horizontal")).toBe(false);
  });

  it("refuses the fold when NO ROOT SUBSET EXISTS in the cell", () => {
    // Spectra publishes "Dual Patch Autographs Gold", "… Meta", "… Neon Pink"
    // and eleven more, but NO plain "Dual Patch Autographs". Inventing the root
    // would mint a key the checklist never names; the colours are reported for
    // a ruling instead. Measured: 6 such keys survive the cbc fold.
    const all = [
      ...rows("Dual Patch Autographs Gold", ROSTER),
      ...rows("Dual Patch Autographs Meta", [["7", "Sauce Gardner"], ["8", "Garrett Wilson"]]),
    ];
    const fold = IS.rungFoldingFor(all);
    expect(fold.size).toBe(0);
  });
});

describe("a product whose NAME ends in a colour word is not stripped", () => {
  // THE NEGATIVE TEST THE RULING ASKED FOR. These are real products, not rungs.
  // A lexical rule keyed on "gold" / "black" / "red" would fold each of them
  // onto a sibling that does not exist; the roster measurement cannot, because
  // there is no root subset to agree with.
  for (const name of ["Gold Standard", "Black Gold", "Red Zone", "Silver Signatures"]) {
    it(`"${name}" alone in its cell folds nowhere`, () => {
      const fold = IS.rungFoldingFor(rows(name, ROSTER));
      expect(fold.size).toBe(0);
    });
  }

  it("a colour-named product is NOT folded onto an unrelated subset that shares a colour word", () => {
    // "Black Gold" and "Gold Standard" share the word "Gold" and nothing else.
    // Neither is a prefix of the other, so no fold is even considered.
    const all = [...rows("Black Gold", ROSTER), ...rows("Gold Standard", ROSTER)];
    expect(IS.rungFoldingFor(all).size).toBe(0);
  });

  it("a product whose name merely STARTS with another subset's name is still measured", () => {
    // The prefix relation is necessary but never sufficient: "Gold Standard"
    // begins with "Gold", but with rosters that disagree it stays its own set.
    const all = [
      ...rows("Gold", ROSTER),
      ...rows("Gold Standard", [["1", "Someone Else"], ["2", "Another Player"]]),
    ];
    expect(IS.rungFoldingFor(all).has("gold-standard")).toBe(false);
  });
});

describe("the fold does not disturb a directory that never needed it", () => {
  it("a file with no subsets at all folds nothing and keeps the product key", () => {
    const base = rows("", ROSTER);
    const fold = IS.rungFoldingFor(base);
    expect(fold.size).toBe(0);
    expect(IS.setKeyForRow({
      productSetKey: "nba-hoops", category: "base", parallel: "", subsetName: null,
      separate: new Set(), foldRungs: fold,
    }).setKey).toBe("nba-hoops");
  });

  it("a tcdb-shaped file, whose colour is in its OWN column, is untouched", () => {
    // The existing tail strip already handles this lane: category
    // `insert-guardians`, parallel "Gold Prizm". The new fold must find nothing
    // to do, or it would be stripping twice.
    const all = [
      { category: "insert-guardians", cardNumber: "1", parallel: "", player: "Rais M'Bolhi", subsetName: null },
      { category: "insert-guardians", cardNumber: "1", parallel: "Gold Prizm", player: "Rais M'Bolhi", subsetName: null },
    ];
    expect(IS.rungFoldingFor(all).size).toBe(0);
    expect(IS.setKeyForRow({
      productSetKey: "panini-prizm-fifa-world-cup", category: "insert-guardians",
      parallel: "Gold Prizm", subsetName: null,
      separate: new Set(["guardians"]), foldRungs: IS.rungFoldingFor(all),
    }).setKey).toBe("panini-prizm-fifa-world-cup-guardians");
  });

  it("planFile with no foldRungs supplied measures the file itself", () => {
    // The default path, and what a one-file-per-product directory needs.
    const all = [
      ...rows("College Penmanship", ROSTER),
      ...rows("College Penmanship Prizms Gold", ROSTER),
    ];
    const plan = IS.planFile({
      rows: all,
      productSetKey: "panini-prizm-draft-picks",
      computeId: (r: Row & { setKey: string }) => [r.setKey, r.cardNumber, r.parallel || "base"].join(":"),
      normalize: (k: string) => k,
    });
    // The fold alone resolves it, and NO KEY IS DERIVED AT ALL: once the colour
    // sits on the parallel axis the two subsets no longer clash, so the
    // separation has nothing to separate and every row keeps the product key.
    // Six rows, six distinct ids, zero registry entries demanded -- right
    // guard, right scope. (A base set numbered 1-3 alongside these WOULD clash,
    // and then the subset takes its own key; that is the cbc shape, measured in
    // the ingest's own dry run.)
    expect(plan.verdict).toBe("pass");
    expect(plan.ids).toBe(6);
    expect(plan.keys).toEqual([]);
    expect([...plan.separate]).toEqual([]);
    expect(plan.foldRungs.get("college-penmanship-prizms-gold").parallel).toBe("Prizms Gold");
  });

  it("a base set numbered alike DOES force the subset onto its own key, colour still on the parallel", () => {
    // The cbc shape. The base print and the subset both number 1-3, so only the
    // subset can say which card it is -- and its colour rung rides with it
    // rather than minting a second key.
    const all = [
      ...rows("", ROSTER),
      ...rows("College Penmanship", ROSTER),
      ...rows("College Penmanship Prizms Gold", ROSTER),
    ];
    const plan = IS.planFile({
      rows: all,
      productSetKey: "panini-prizm-draft-picks",
      computeId: (r: Row & { setKey: string }) => [r.setKey, r.cardNumber, r.parallel || "base"].join(":"),
      normalize: (k: string) => k,
    });
    expect(plan.verdict).toBe("pass");
    expect(plan.ids).toBe(9);
    // ONE key for the subset, not two: the Gold rung is a parallel of it.
    expect(plan.keys.map((k: { setKey: string }) => k.setKey))
      .toEqual(["panini-prizm-draft-picks-college-penmanship"]);
  });
});
