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
const { toCsvRows, sheetNameFor } = require("../scripts/convertChecklistInsiderToChecklistCsv.cjs");

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

  it("emits an empty parallel for an unsectioned product", () => {
    const { rows } = toCsvRows(LADDER_ONLY_PRODUCT);
    expect(rows.every((r: { parallel: string }) => r.parallel === "")).toBe(true);
  });
});

describe("a ladder is not a set of cards", () => {
  it("never multiplies base cards by ladder rungs", () => {
    // 4 cards x 2 ladder rungs = 8 rows would be 8 cards no source published.
    const { rows } = toCsvRows(LADDER_ONLY_PRODUCT);
    expect(rows).toHaveLength(4);
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
