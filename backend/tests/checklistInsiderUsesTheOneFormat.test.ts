/**
 * CF-EVERY-INGEST-USES-THE-ONE-FORMAT (Drew, 2026-08-26).
 *
 * "When we ingest it follows the same format. That is a rule."
 *
 * The rule is easy to satisfy in the header and hard to satisfy in the rows.
 * The first version of this converter emitted a perfectly canonical header and
 * then lost 95% of the cards: it labelled every subset as belonging to the
 * "Base" sheet, categoryFor returned "base" for all of them, classifySections
 * treats category "base" as an outright ANCHOR, so all 224 subsets became
 * anchors, none folded to a parallel, every row carried the same blank
 * parallel, and the dedup collapsed 9,680 rows to 521.
 *
 * That is the failure this file exists to prevent, and it is the shape that
 * keeps recurring: a silent collapse that looks exactly like a small product.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toCsvRows, sheetNameFor, ladderAppliesTo } = require("../scripts/convertChecklistInsiderToChecklistCsv.cjs");

/** 2023 Panini Elite Extra Edition in miniature: one plain run + parallels sharing its numbers. */
const PARALLEL_PRODUCT = {
  slug: "2023-panini-elite-extra-edition-baseball",
  parallels: [],
  cards: [
    ...[1, 2, 3].map((n) => ({ subset: "Base", cardNumber: String(n), player: `P${n}`, printRun: null, isAuto: null })),
    ...[1, 2, 3].map((n) => ({ subset: "Base Black", cardNumber: String(n), player: `P${n}`, printRun: null, isAuto: null })),
    ...[1, 2, 3].map((n) => ({ subset: "Base Pink", cardNumber: String(n), player: `P${n}`, printRun: 25, isAuto: null })),
  ],
};

/** 2023 Bowman Inception: base cards plus a ladder with no per-card rows. */
const LADDER_ONLY_PRODUCT = {
  slug: "2023-bowman-inception-baseball",
  parallels: [
    { list: "Base Parallels", parallel: "Blue Foil", printRun: 99 },
    { list: "Base Parallels", parallel: "Gold Foil", printRun: 50 },
  ],
  cards: [1, 2, 3, 4].map((n) => ({ subset: null, cardNumber: String(n), player: `Q${n}`, printRun: null, isAuto: null })),
};

describe("parallels fold instead of collapsing", () => {
  it("keeps every card — the 9,680 -> 521 regression", () => {
    const { rows } = toCsvRows(PARALLEL_PRODUCT);
    expect(rows).toHaveLength(9);
  });

  it("names the rung by what the subset ADDS to the anchor", () => {
    const { rows } = toCsvRows(PARALLEL_PRODUCT);
    const parallels = new Set(rows.map((r: { parallel: string }) => r.parallel));
    expect(parallels).toEqual(new Set(["", "Black", "Pink"]));
  });

  it("counts one anchor and two parallel rungs", () => {
    const { anchors, parallels } = toCsvRows(PARALLEL_PRODUCT);
    expect(anchors).toBe(1);
    expect(parallels).toBe(2);
  });

  it("gives each (number, parallel) its own row so dedup cannot merge them", () => {
    const { rows } = toCsvRows(PARALLEL_PRODUCT);
    const keys = rows.map((r: { cardNumber: string; parallel: string }) => `${r.cardNumber}|${r.parallel}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("blank means unknown, never the string Base", () => {
  it("emits an empty parallel for the plain run", () => {
    const { rows } = toCsvRows(PARALLEL_PRODUCT);
    const base = rows.filter((r: { parallel: string }) => r.parallel === "");
    expect(base).toHaveLength(3);
    expect(rows.some((r: { parallel: string }) => r.parallel === "Base")).toBe(false);
  });

  it("still emits the plain card alongside its rungs", () => {
    const { rows } = toCsvRows(LADDER_ONLY_PRODUCT);
    const plain = rows.filter((r: { parallel: string }) => r.parallel === "");
    expect(plain).toHaveLength(4);
    expect(rows.some((r: { parallel: string }) => r.parallel === "Base")).toBe(false);
  });
});

/**
 * POLICY REVERSAL, Drew 2026-08-26: "no, we need all the parallels".
 *
 * This file previously asserted the opposite — that a ladder is never expanded
 * into cards. That reading of `no-synthetic-parallels` was too broad. The rule
 * forbids TEMPLATES: a generic parallel list applied to sets with no evidence.
 * A ladder published BY THE SOURCE FOR THIS PRODUCT, with print runs and pack
 * odds, is scraped evidence about this specific run of cards.
 *
 * It matters most exactly where nothing else can help: 2026 Bowman Chrome Mega
 * Box has 12 Mojo rungs on its page and ZERO in its workbook, Beckett publishes
 * none because Topps has not released them, and 7,786 sales name "Mojo
 * Refractor". The page ladder is the only source that exists.
 */
describe("a published ladder becomes cards", () => {
  it("expands each card across the product's own rungs", () => {
    // 4 cards x (1 plain + 2 rungs) = 12.
    const { rows, expanded } = toCsvRows(LADDER_ONLY_PRODUCT);
    expect(rows).toHaveLength(12);
    expect(expanded).toBe(8);
  });

  it("carries the print run the ladder states", () => {
    const { rows } = toCsvRows(LADDER_ONLY_PRODUCT);
    const gold = rows.filter((r: { parallel: string }) => r.parallel === "Gold Foil");
    expect(gold).toHaveLength(4);
    expect(gold.every((r: { printRun: string }) => r.printRun === "50")).toBe(true);
  });

  it("scopes a Base ladder to base cards, never to autographs", () => {
    // The cross join this rule actually forbids: 77 of 603 products publish
    // more than one list, and an autograph ladder on base cards is a template.
    expect(ladderAppliesTo("2025 Bowman Chrome Base Parallels List", "base")).toBe(true);
    expect(ladderAppliesTo("2025 Bowman Chrome Base Parallels List", "auto-cpa")).toBe(false);
    expect(ladderAppliesTo("Chrome Prospect Autographs Parallels List", "auto-cpa")).toBe(true);
    expect(ladderAppliesTo("Chrome Prospect Autographs Parallels List", "base")).toBe(false);
  });

  it("strips the trailing -1 the source appends to a one-of-one", () => {
    const { rows } = toCsvRows({
      slug: "x", parallels: [{ list: "Base Parallels List", parallel: "Rose Gold Mojo Refractor - 1", printRun: 1 }],
      cards: [{ subset: null, cardNumber: "1", player: "A", printRun: null, isAuto: null }],
    });
    expect(rows.some((r: { parallel: string }) => r.parallel === "Rose Gold Mojo Refractor")).toBe(true);
  });
});

describe("only the plain run may claim the Base sheet", () => {
  it("routes the plain run to Base and its variants elsewhere", () => {
    expect(sheetNameFor("Base", [{}])).toBe("Base");
    expect(sheetNameFor(null, [{}])).toBe("Base");
    expect(sheetNameFor("Base Black", [{}])).toBe("Inserts");
    expect(sheetNameFor("Base Aspirations Blue", [{}])).toBe("Inserts");
  });

  it("routes signed runs to Autographs so they fold onto signed anchors", () => {
    expect(sheetNameFor("Rookie Autographs", [{}])).toBe("Autographs");
    expect(sheetNameFor("Base Black", [{ isAuto: true }])).toBe("Autographs");
  });
});

describe("the six columns, in order", () => {
  it("emits exactly the canonical shape", () => {
    const { rows } = toCsvRows(PARALLEL_PRODUCT);
    expect(Object.keys(rows[0])).toEqual([
      "category", "cardNumber", "parallel", "isAuto", "printRun", "player",
    ]);
  });

  it("carries the print run through from the card row", () => {
    const { rows } = toCsvRows(PARALLEL_PRODUCT);
    const pink = rows.filter((r: { parallel: string }) => r.parallel === "Pink");
    expect(pink.every((r: { printRun: number }) => r.printRun === 25)).toBe(true);
  });
});

/**
 * R-0927D / CF-UNSIGNED-MINT-DEFECT (Drew ruling, 2026-09-27 ~02:50Z; census
 * DRAFT PR #2453, C:/tmp/unsigned_1949/RESULT.md -- 22 (setKey, prefix, year)
 * groups / 3,265 pairs in baseball). The checklistinsider LAYOUT mints
 * AUTOGRAPH-ONLY inserts as isAuto=false: the staged JSONL's per-card
 * `isAuto` flag on an autograph-section row is NOT trustworthy. isAuto must
 * come from the SECTION's own category (sec.category.startsWith("auto-")),
 * exactly the rule convertBeckettChecklistXlsx.cjs already applies at its own
 * emit site -- never from the raw per-card flag, and never from sale-title
 * text (feedback_isauto_boundary_is_cardnumber_not_text.md).
 *
 * This fixture is shaped like a REAL checklistinsider product page: an
 * "Autographs" subset (the source's own section name, exactly as
 * sheetNameFor's "routes signed runs to Autographs" test above already
 * exercises) whose staged rows carry the DEFECTIVE `isAuto: false` the
 * census found at scale, alongside an ordinary "Base" subset with the same
 * (correct) flag shape.
 */
const INSIDER_LAYOUT_PRODUCT = {
  slug: "2024-bowman-chrome-baseball",
  parallels: [],
  cards: [
    // Autograph section: real checklistinsider rows carry isAuto: false on
    // every row here (the minting defect) -- the fix must NOT trust this.
    { subset: "Autographs", cardNumber: "CPA-JS", player: "John Smith", printRun: null, isAuto: false },
    { subset: "Autographs", cardNumber: "CPA-AB", player: "Ann Baker", printRun: null, isAuto: false },
    // Base section: ordinary unsigned cards, correctly flagged false.
    { subset: "Base", cardNumber: "1", player: "P1", printRun: null, isAuto: false },
    { subset: "Base", cardNumber: "2", player: "P2", printRun: null, isAuto: false },
  ],
};

describe("R-0927d: isAuto comes from the section's category, never the raw per-card flag", () => {
  it("autograph-section rows emit isAuto=true even though the staged flag says false (the minting defect)", () => {
    const { rows } = toCsvRows(INSIDER_LAYOUT_PRODUCT);
    const autoRows = rows.filter((r: { cardNumber: string }) => r.cardNumber.startsWith("CPA-"));
    expect(autoRows).toHaveLength(2);
    expect(autoRows.every((r: { isAuto: string }) => r.isAuto === "true")).toBe(true);
  });

  it("base-section rows emit isAuto=false", () => {
    const { rows } = toCsvRows(INSIDER_LAYOUT_PRODUCT);
    const baseRows = rows.filter((r: { cardNumber: string }) => !r.cardNumber.startsWith("CPA-"));
    expect(baseRows).toHaveLength(2);
    expect(baseRows.every((r: { isAuto: string }) => r.isAuto === "false")).toBe(true);
  });

  // ── MUTATION CHECK: reverting to the raw `c.isAuto` flag reproduces the
  // defect on this exact fixture, proving the section-category fix is
  // load-bearing and not a no-op on real Insider-shaped data.
  it("MUTATION: trusting the raw per-card isAuto flag instead of the section category reproduces the minting defect", () => {
    const regressedIsAuto = (c: { isAuto?: boolean | null }) =>
      c.isAuto === true ? "true" : c.isAuto === false ? "false" : "";
    const staged = INSIDER_LAYOUT_PRODUCT.cards.filter((c) => c.cardNumber.startsWith("CPA-"));
    const regressedOutput = staged.map((c) => regressedIsAuto(c));
    expect(regressedOutput.every((v) => v === "false"), "the OLD (regressed) behavior mints these autograph-section rows as isAuto=false").toBe(true);

    const { rows } = toCsvRows(INSIDER_LAYOUT_PRODUCT);
    const realOutput = rows.filter((r: { cardNumber: string }) => r.cardNumber.startsWith("CPA-")).map((r: { isAuto: string }) => r.isAuto);
    expect(realOutput.every((v: string) => v === "true"), "the REAL (fixed) converter must never reproduce the mutation's isAuto=false on an autograph section").toBe(true);
  });
});
