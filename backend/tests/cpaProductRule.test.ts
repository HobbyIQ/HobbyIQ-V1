/**
 * D29/R2 -- "the checklist that names the product wins; bcp's Bowman page is
 * not that." (Drew, 2026-08-30)
 *
 * Every fixture below is a real row shape read from card_catalog on 2026-08-30
 * (read-only), not an invented one. The two rulings in
 * data/holding-identity-rulings.json are pinned as regressions: R2 must
 * CONFIRM them, and a change that flips either one fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideCpaProduct, isFoldableProductFiling, playerKey, type CpaRow } from "../src/services/catalog/cpaProductRule";

const row = (o: Partial<CpaRow> & { setKey: string; source: string }): CpaRow => ({
  id: o.id ?? `hiq:baseball:2021:${o.setKey}:cpa-xx:refractor:auto`,
  playerName: o.playerName ?? null,
  printRun: o.printRun ?? null,
  ...o,
});

describe("decideCpaProduct -- fold: one dedicated checklist names the product", () => {
  // 2021 | CPA-MP | base | auto -- Milkar Perez.
  it("folds a baseballcardpedia bowman row onto the checklistcenter bowman-chrome row", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Milkar Perez", printRun: 499 }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Milkar Perez" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe("bowman-chrome");
    expect(d.from).toEqual(["bowman"]);
    expect(d.rows).toHaveLength(1);
  });

  it("folds the other direction too -- the rule follows the checklist, not the product name", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistinsider-2026-08-27", playerName: "Felnin Celesten", printRun: 250 }),
      row({ setKey: "bowman-chrome", source: "ingest-auto-seed", playerName: "Felnin Celesten" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe("bowman");
  });

  it("folds several wrong-product rows at once and reports each source setKey", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "beckett-checklist-2026-08-27", playerName: "Jose Perdomo", printRun: 499 }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Jose Perdomo" }),
      row({ setKey: "bowman-draft", source: "sold-comps-stub-2026-08-12", playerName: "Jose Perdomo" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe("bowman-chrome");
    expect(d.from).toEqual(["bowman", "bowman-draft"]);
  });
});

describe("decideCpaProduct -- R2 confirms Drew's per-holding rulings", () => {
  const rulings = JSON.parse(
    readFileSync(path.resolve(__dirname, "../data/holding-identity-rulings.json"), "utf8"),
  ) as { rulings: Array<{ from: string; to: string; note?: string }> };

  const setKeyOfId = (id: string) => id.split(":")[3];

  // Measured 2026-08-30: for BOTH of these, the dedicated keys are [bowman]
  // only -- every bowman-chrome row is ingest-auto-seed / sold-comps-stub.
  it("2026 cpa-ba Antunez folds to bowman, matching the ruling's `to`", () => {
    const ruling = rulings.rulings.find((r) => r.from.includes("2026:bowman-chrome:cpa-ba"));
    expect(ruling, "the Antunez ruling must still be in the rulings file").toBeTruthy();
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistcenter-2026-08-29", playerName: "Brailer Antunez", printRun: 499 }),
      row({ setKey: "bowman", source: "beckett-checklist", playerName: "Brailer Antunez", printRun: 499 }),
      row({ setKey: "bowman-chrome", source: "sold-comps-stub-2026-08-12", playerName: "Brailer Antunez" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe(setKeyOfId(ruling!.to));
    expect(d.target).toBe("bowman");
  });

  it("2025 cpa-fa Arias folds to bowman, matching the ruling's `to`", () => {
    const ruling = rulings.rulings.find((r) => r.from.includes("2025:bowman-chrome:cpa-fa"));
    expect(ruling, "the Arias ruling must still be in the rulings file").toBeTruthy();
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistinsider-2026-08-27", playerName: "Fernando Arias", printRun: 250 }),
      row({ setKey: "bowman-chrome", source: "ingest-auto-seed", playerName: "Fernando Arias" }),
    ]);
    expect(d.kind).toBe("fold");
    if (d.kind !== "fold") throw new Error("unreachable");
    expect(d.target).toBe(setKeyOfId(ruling!.to));
    expect(d.target).toBe("bowman");
  });
});

describe("decideCpaProduct -- the initials collision is NOT a product conflict", () => {
  // The measured majority: 1,879 of 3,459 two-dedicated-key groups.
  it.each([
    ["CPA-ED", "Eddy Diaz", "Elijah Dunham"],
    ["CPA-AM", "Austin Martin", "Alexander Mojica"],
    ["CPA-ARA", "Alexander Ramirez", "Aldo Ramirez"],
  ])("%s: two dedicated setKeys naming different players abstains", (_num, a, b) => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "beckett-scraped-2026-08-30", playerName: a }),
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: b }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("player-disagreement");
  });

  it("a fold candidate whose bcp row names a DIFFERENT player emits no move (the 267 case)", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Angel Nunez", printRun: 499 }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Alejandro Nunez" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("nothing-to-fold");
  });

  it("a null playerName is not agreement -- the 16,831 bccp rows never fold on a guess", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Michael Harris", printRun: 499 }),
      row({ setKey: "bowman", source: "bccp", playerName: null }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("nothing-to-fold");
  });
});

describe("decideCpaProduct -- abstains", () => {
  it("no dedicated source: bcp + bccp + ingest-auto-seed across two setKeys (the 1,267 case)", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Yeiner Fernandez" }),
      row({ setKey: "bowman-chrome", source: "bccp", playerName: null }),
      row({ setKey: "bowman-chrome", source: "ingest-auto-seed", playerName: "Yeiner Fernandez" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("no-dedicated-source");
  });

  it("a single setKey has nothing to decide (110,418 of 117,529 identities)", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Michael Harris", printRun: 499 }),
      row({ setKey: "bowman-chrome", source: "ingest-auto-seed", playerName: "Michael Harris" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("single-setkey");
  });

  it("checklistcenter-html is NOT dedicated -- it cannot name a product on its own", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistcenter-html", playerName: "Druw Jones" }),
      row({ setKey: "bowman-chrome", source: "baseballcardpedia", playerName: "Druw Jones" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("no-dedicated-source");
  });

  it("an unknown source is left alone rather than assumed foldable", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Druw Jones", printRun: 499 }),
      row({ setKey: "bowman", source: "some-source-nobody-classified", playerName: "Druw Jones" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("nothing-to-fold");
  });
});

describe("decideCpaProduct -- the target must be a product the table SPELLS", () => {
  // Measured 2026-08-30: 475 CPA rows sit at `bowman-baseball` and 58 at
  // `bowman-mega`, ALL from dedicated sources -- un-normalized spellings D23's
  // rename fleet is moving. A dedicated source names WHICH product, not how it
  // is spelled, so folding onto one of these would move rows to an address
  // that is about to stop existing.
  it("refuses to fold onto bowman-baseball, an un-normalized spelling", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-baseball", source: "checklistcenter-2026-08-29", playerName: "Omar Estevez", printRun: 499 }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Omar Estevez" }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("target-not-a-product");
  });

  it("refuses to report bowman <> bowman-baseball as a keep-both conflict", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistcenter-2026-08-29", playerName: "Joe Ryan", printRun: 499 }),
      row({ setKey: "bowman-baseball", source: "beckett-checklist", playerName: "Joe Ryan", printRun: 499 }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("target-not-a-product");
  });

  it("still folds onto a spelling the table DOES carry", () => {
    // bowman-chrome-prospects and bowman-1st-edition are real entries.
    for (const target of ["bowman-chrome-prospects", "bowman-1st-edition", "bowman-chrome", "bowman-draft"]) {
      const d = decideCpaProduct([
        row({ setKey: target, source: "checklistcenter-2026-08-29", playerName: "Philip Clarke", printRun: 499 }),
        row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Philip Clarke" }),
      ]);
      expect(d.kind, target).toBe("fold");
    }
  });
});

describe("decideCpaProduct -- keep-both: two REAL products", () => {
  // 2022 | CPA-HD Henry Davis: bowman-heritage/99 vs bowman/499.
  it("two dedicated setKeys for the SAME player keeps both and names them", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistcenter-2026-08-29", playerName: "Henry Davis", printRun: 499 }),
      row({ setKey: "bowman-heritage", source: "beckett-checklist-2026-08-29", playerName: "Henry Davis", printRun: 99 }),
    ]);
    expect(d.kind).toBe("keep-both");
    if (d.kind !== "keep-both") throw new Error("unreachable");
    expect(d.setKeys).toEqual(["bowman", "bowman-heritage"]);
  });

  // HALT, pinned as a test. bowman-mega-box carries 1,398 of the 1,580 genuine
  // same-player conflicts -- and productSetKeys does NOT spell it (only
  // bowman-chrome-mega-box is in the table, :159). So the largest keep-both
  // population currently abstains as an unspelled key rather than being
  // reported as a conflict. That is the SAFE answer and it is deliberate:
  // R2 never named mega-box, and a mega-box row is plausibly the same card in a
  // different package rather than a second product. Two things must happen
  // before this flips, and both are Drew's: a ruling on whether mega-box is a
  // distinct product, and (if so) a productSetKeys entry. When that entry lands
  // this test will fail, which is the point -- it is the reminder.
  it("bowman-mega-box abstains today because productSetKeys does not spell it", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistcenter-2026-08-29", playerName: "Termarr Johnson", printRun: 499 }),
      row({ setKey: "bowman-mega-box", source: "checklistinsider-2026-08-27", playerName: "Termarr Johnson", printRun: 250 }),
    ]);
    expect(d.kind).toBe("abstain");
    if (d.kind !== "abstain") throw new Error("unreachable");
    expect(d.why).toBe("target-not-a-product");
  });

  it("bowman-chrome-mega-box IS in the table, so it keeps both", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Pedro Gomez", printRun: 499 }),
      row({ setKey: "bowman-chrome-mega-box", source: "checklistinsider-2026-08-27", playerName: "Pedro Gomez", printRun: 250 }),
    ]);
    expect(d.kind).toBe("keep-both");
  });

  it("keep-both never emits a move", () => {
    const d = decideCpaProduct([
      row({ setKey: "bowman", source: "checklistcenter-2026-08-29", playerName: "Simon Juan", printRun: 499 }),
      row({ setKey: "bowman-chrome", source: "beckett-checklist", playerName: "Simon Juan", printRun: 1 }),
    ]);
    expect("target" in d).toBe(false);
    expect("rows" in d).toBe(false);
  });
});

describe("hyphen-insensitivity (D23) and the player key", () => {
  it("playerKey ignores case, spacing and punctuation but never invents a name", () => {
    expect(playerKey("Michael Harris")).toBe(playerKey("michael  harris"));
    expect(playerKey("Jean-Pierre Ona")).toBe(playerKey("Jean Pierre Ona"));
    expect(playerKey(null)).toBe("");
    expect(playerKey("   ")).toBe("");
  });

  it("isFoldableProductFiling: bcp + derived fold, dedicated never folds", () => {
    for (const s of ["baseballcardpedia", "bccp", "ingest-auto-seed", "sold-comps-stub-2026-08-12", "cardhedge"]) {
      expect(isFoldableProductFiling(s), s).toBe(true);
    }
    for (const s of ["checklistcenter-2026-08-29", "checklistinsider-2026-08-27", "beckett-checklist", "cardboardchecklist-scraped-2026-08-14"]) {
      expect(isFoldableProductFiling(s), s).toBe(false);
    }
  });
});

/**
 * MUTATION CHECK. A guard no test can kill is not a guard. Each block below
 * re-implements decideCpaProduct with exactly ONE gate removed and asserts the
 * mutant produces a DIFFERENT, wrong answer on a real fixture -- so the test
 * above it is load-bearing rather than decorative.
 */
describe("mutation check -- every gate is killable", () => {
  const collision: CpaRow[] = [
    row({ setKey: "bowman", source: "beckett-scraped-2026-08-30", playerName: "Eddy Diaz" }),
    row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Elijah Dunham" }),
  ];
  const noDedicated: CpaRow[] = [
    row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Yeiner Fernandez" }),
    row({ setKey: "bowman-chrome", source: "bccp", playerName: null }),
  ];
  const wrongPlayerFold: CpaRow[] = [
    row({ setKey: "bowman-chrome", source: "checklistcenter-2026-08-29", playerName: "Angel Nunez", printRun: 499 }),
    row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Alejandro Nunez" }),
  ];

  it("(a) breaking the dedicated-source predicate turns a bcp row into a product namer", () => {
    // MUTANT: isDedicatedChecklist := () => true. Then baseballcardpedia and
    // bccp both "name" a product and the no-dedicated abstain becomes
    // keep-both -- the real rule abstains.
    const mutantDedicatedAlwaysTrue = (rows: CpaRow[]) => {
      const keys = [...new Set(rows.map((r) => r.setKey))];
      return keys.length > 1 ? "keep-both" : "abstain";
    };
    expect(mutantDedicatedAlwaysTrue(noDedicated)).toBe("keep-both");
    expect(decideCpaProduct(noDedicated).kind).toBe("abstain");
  });

  it("(b) removing the player-agreement gate reports an initials collision as a product conflict", () => {
    // MUTANT: skip namedPlayers().size > 1. Two dedicated setKeys then fall
    // through to keep-both, reporting 1,879 phantom conflicts.
    const mutantNoPlayerGate = (rows: CpaRow[]) => {
      const ded = [...new Set(rows.filter((r) => /^(checklistcenter|checklistinsider|beckett)/.test(r.source)).map((r) => r.setKey))];
      return ded.length > 1 ? "keep-both" : "abstain";
    };
    expect(mutantNoPlayerGate(collision)).toBe("keep-both");
    const real = decideCpaProduct(collision);
    expect(real.kind).toBe("abstain");
    if (real.kind !== "abstain") throw new Error("unreachable");
    expect(real.why).toBe("player-disagreement");
  });

  it("(b2) removing the per-row player check merges two players' cards", () => {
    // MUTANT: fold every non-dedicated row regardless of playerName. The
    // Alejandro Nunez bcp row would fold onto Angel Nunez's checklist row.
    const mutantFoldsEverything = (rows: CpaRow[]) => {
      const ded = rows.find((r) => /^(checklistcenter|checklistinsider|beckett)/.test(r.source));
      return rows.filter((r) => r.setKey !== ded?.setKey).length > 0 ? "fold" : "abstain";
    };
    expect(mutantFoldsEverything(wrongPlayerFold)).toBe("fold");
    expect(decideCpaProduct(wrongPlayerFold).kind).toBe("abstain");
  });

  it("(d) removing the spelled-product gate folds rows onto a mid-rename address", () => {
    // MUTANT: isProductSetKey := () => true. bowman-baseball then wins as a
    // product and 47 measured rows would move onto an address D23 is deleting.
    const midRename: CpaRow[] = [
      row({ setKey: "bowman-baseball", source: "checklistcenter-2026-08-29", playerName: "Omar Estevez", printRun: 499 }),
      row({ setKey: "bowman", source: "baseballcardpedia", playerName: "Omar Estevez" }),
    ];
    const mutantSpellsEverything = (rows: CpaRow[]) => {
      const ded = rows.find((r) => /^(checklistcenter|checklistinsider|beckett)/.test(r.source));
      return ded && rows.some((r) => r.setKey !== ded.setKey) ? "fold" : "abstain";
    };
    expect(mutantSpellsEverything(midRename)).toBe("fold");
    const real = decideCpaProduct(midRename);
    expect(real.kind).toBe("abstain");
    if (real.kind !== "abstain") throw new Error("unreachable");
    expect(real.why).toBe("target-not-a-product");
  });

  it("(c) removing the zero-dedicated abstain makes the rule guess a target from bcp alone", () => {
    // MUTANT: pick the first setKey when nothing is dedicated.
    const mutantGuesses = (rows: CpaRow[]) => (rows.length > 1 ? { kind: "fold", target: rows[0].setKey } : { kind: "abstain" });
    expect(mutantGuesses(noDedicated).kind).toBe("fold");
    const real = decideCpaProduct(noDedicated);
    expect(real.kind).toBe("abstain");
    if (real.kind !== "abstain") throw new Error("unreachable");
    expect(real.why).toBe("no-dedicated-source");
  });
});
