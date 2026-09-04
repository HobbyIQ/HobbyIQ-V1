/**
 * CF-A-TIFFANY-IS-NOT-A-SUBSET (2026-09-04, follow-on to #1745 / #1741 / #1719).
 *
 * #1745's repair lane moves a Tiffany row off the paper product's setKey and
 * onto the Tiffany product's own -- but ONLY where that product exists. It
 * gates 1,339 catalog rows and 994 comps behind a live sibling count because
 * `fleer-tiffany`, `fleer-update-tiffany`, `fleer-tradition-tiffany` and
 * `base-set-tiffany` held ZERO rows: "retiring a Fleer rung would delete the
 * only rows those cards have -- acquire before retire".
 *
 * This file pins the acquisition. Two independent defects had to be fixed for
 * the staged checklists to mean anything, and each is pinned by a mutation that
 * goes red:
 *
 *   1. THE KEY WAS NOT A FIXED POINT. `normalizeSetKey("fleer-tiffany")`
 *      returned `fleer` -- the unanchored brand rule swallowing the product,
 *      the exact collapse Drew forbade on 2026-09-03. A ruled key MUST be a
 *      normalizeSetKey fixed point, or the pool can never name the checklist
 *      it now has. Declaring the products with `P` was NOT enough (only
 *      `spelled` products answer productSetKeyForName, which is the leg that
 *      runs before the brand patterns) -- so this asserts the function's real
 *      output, never the table's contents.
 *
 *   2. THE FETCHER REPARENTED THEM. #1741 rules that a page extending a known
 *      brand belongs to that brand -- right for `topps-chrome-cards-that-never-
 *      were`, an insert with no pool of its own; wrong for a coated reprint of
 *      the WHOLE checklist, which is its own product with its own price curve.
 *      Left alone it also regressed the eight checklists #1719 shipped:
 *      re-fetching 1990 Topps Traded Tiffany wrote `setKey: "topps"`, folding
 *      132 Tiffany cards into flagship Topps. #1743 is the record of a recheck
 *      re-breaking 1991 Tiffany by exactly this shape, so this is pinned in
 *      BOTH directions -- the reprints keep their key, the real inserts still
 *      reparent.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { isProductSetKey, isSameNumberParallelSet, productParentOf } from "../src/services/catalog/productSetKeys";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { splitParentAndSubset } = require("../scripts/fetchSportsCardChecklist.cjs");

const SCRAPED = join(__dirname, "..", "data", "checklists", "scraped");

/** The five products this acquisition mints, and the parent each reprints. */
const COATED: ReadonlyArray<{ key: string; parent: string }> = [
  { key: "fleer-tiffany", parent: "fleer" },
  { key: "fleer-glossy", parent: "fleer" },
  { key: "fleer-update-tiffany", parent: "fleer-update" },
  { key: "fleer-update-glossy", parent: "fleer-update" },
  { key: "fleer-tradition-tiffany", parent: "fleer-tradition" },
];

/**
 * Every staged file, with the count and the first/last card number the fetch
 * verified. A number here that stops matching the CSV means the file changed
 * under us -- which is the only way a "600-card set" silently becomes 599.
 */
const STAGED: ReadonlyArray<{
  file: string; setKey: string; year: number; sport: string;
  cards: number; first: string; last: string;
}> = [
  { file: "1987-fleer-glossy-baseball", setKey: "fleer-glossy", year: 1987, sport: "baseball", cards: 672, first: "1", last: "WS12" },
  { file: "1988-fleer-glossy-baseball", setKey: "fleer-glossy", year: 1988, sport: "baseball", cards: 660, first: "1", last: "660" },
  { file: "1989-fleer-glossy-baseball", setKey: "fleer-glossy", year: 1989, sport: "baseball", cards: 660, first: "1", last: "660" },
  { file: "1987-fleer-update-glossy-baseball", setKey: "fleer-update-glossy", year: 1987, sport: "baseball", cards: 132, first: "U-1", last: "U-132" },
  { file: "1988-fleer-update-glossy-baseball", setKey: "fleer-update-glossy", year: 1988, sport: "baseball", cards: 132, first: "U-1", last: "U-132" },
  { file: "1996-fleer-tiffany-baseball", setKey: "fleer-tiffany", year: 1996, sport: "baseball", cards: 600, first: "1", last: "600" },
  { file: "1996-fleer-update-tiffany-baseball", setKey: "fleer-update-tiffany", year: 1996, sport: "baseball", cards: 250, first: "U1", last: "U250" },
  { file: "1997-fleer-tiffany-baseball", setKey: "fleer-tiffany", year: 1997, sport: "baseball", cards: 761, first: "1", last: "761" },
  { file: "2002-fleer-tiffany-baseball", setKey: "fleer-tiffany", year: 2002, sport: "baseball", cards: 540, first: "1", last: "540" },
  { file: "1997-98-fleer-tiffany-basketball", setKey: "fleer-tiffany", year: 1997, sport: "basketball", cards: 350, first: "1", last: "350" },
  { file: "2002-fleer-tradition-tiffany-football", setKey: "fleer-tradition-tiffany", year: 2002, sport: "football", cards: 300, first: "1", last: "300" },
  { file: "2003-fleer-tradition-tiffany-football", setKey: "fleer-tradition-tiffany", year: 2003, sport: "football", cards: 300, first: "1", last: "300" },
];

function rows(file: string): string[][] {
  const text = readFileSync(join(SCRAPED, `${file}.csv`), "utf8").trim();
  return text.split(/\r?\n/).slice(1).map((l) => l.split(","));
}

describe("the Fleer coated reprints are products, not rungs", () => {
  it("every ruled key is a normalizeSetKey FIXED POINT", () => {
    // MUTATION: change any S(...) back to P(...) in productSetKeys.ts and this
    // goes red -- `fleer-tiffany` collapses to `fleer`. That collapse is what
    // made the checklist unnameable by the pool it is supposed to price.
    for (const { key } of COATED) {
      expect(normalizeSetKey(key), `${key} must survive normalizeSetKey unchanged`).toBe(key);
      expect(isProductSetKey(key)).toBe(true);
    }
  });

  it("each one declares the parent whose checklist it reprints, at the parent's own numbers", () => {
    for (const { key, parent } of COATED) {
      expect(productParentOf(key)).toBe(parent);
      // The coated card carries the paper card's number, so the number cannot
      // tell them apart and only the title can -- the L5 leg needs to know.
      expect(isSameNumberParallelSet(key, parent), `${key} reprints ${parent} at its numbers`).toBe(true);
    }
    // The parents themselves are NOT their own coated reprint.
    expect(isSameNumberParallelSet("fleer", "fleer")).toBe(false);
  });

  it("the fetcher does NOT reparent a coated reprint onto the paper brand", () => {
    // MUTATION: delete the PRODUCT_TAIL_RE guard in splitParentAndSubset and
    // every one of these returns parentSetKey "fleer"/"topps" with the coating
    // demoted to a subset -- which is what writes `setKey: "fleer"` into the
    // manifest and puts 600 Tiffany cards in the paper pool.
    for (const rest of [
      "fleer-tiffany", "fleer-glossy", "fleer-update-tiffany",
      "fleer-update-glossy", "fleer-tradition-tiffany",
    ]) {
      expect(splitParentAndSubset(rest, null), rest).toEqual({ parentSetKey: "", subset: "" });
    }
  });

  it("REGRESSION: the eight checklists #1719 shipped still keep their own key", () => {
    // The live slug is `topps-tiffany-traded`, not `topps-traded-tiffany`.
    // Before this fix it split to parent `topps` + subset "Tiffany Traded",
    // silently overwriting a shipped product key on any re-fetch (#1743).
    expect(splitParentAndSubset("topps-tiffany-traded", null)).toEqual({ parentSetKey: "", subset: "" });
    expect(splitParentAndSubset("topps-tiffany", null)).toEqual({ parentSetKey: "", subset: "" });
    expect(splitParentAndSubset("bowman-tiffany", null)).toEqual({ parentSetKey: "", subset: "" });
  });

  it("a REAL insert still reparents — the #1741 rule is narrowed, not removed", () => {
    // If this ever returns "" the guard has been widened into the defect #1741
    // exists to fix, and 57 phantom product keys come back.
    expect(splitParentAndSubset("topps-chrome-cards-that-never-were", null))
      .toEqual({ parentSetKey: "topps-chrome", subset: "Cards That Never Were" });
    expect(splitParentAndSubset("topps-chrome-zone-busters", null))
      .toEqual({ parentSetKey: "topps-chrome", subset: "Zone Busters" });
  });

  describe.each(STAGED)("$file", (s) => {
    it("is staged with the counted cards and the verified first/last", () => {
      const r = rows(s.file);
      expect(r.length).toBe(s.cards);
      expect(r[0][1]).toBe(s.first);
      expect(r[r.length - 1][1]).toBe(s.last);
    });

    it("carries NO parallel on any row — the coating is the PRODUCT", () => {
      // MUTATION RED. A non-blank parallel here is the split pool this whole
      // lane exists to close: the card would price as a rung of the paper set
      // AND as its own product, from two partial pools.
      const bad = rows(s.file).filter((c) => (c[2] ?? "").trim() !== "");
      expect(bad.map((c) => c[1])).toEqual([]);
    });

    it("its manifest names the fixed-point setKey and its own source URL", () => {
      const mPath = join(SCRAPED, `${s.file}.manifest.json`);
      expect(existsSync(mPath)).toBe(true);
      const m = JSON.parse(readFileSync(mPath, "utf8"));
      // MUTATION RED: setKey collapsing to the parent brand.
      expect(m.setKey).toBe(s.setKey);
      expect(normalizeSetKey(m.setKey)).toBe(s.setKey);
      expect(m.productKey).toBe(`${s.year}-${s.setKey}`);
      expect(m.year).toBe(s.year);
      expect(m.sport).toBe(s.sport);
      expect(m.rowCount).toBe(s.cards);
      expect(m.parallelOfParent).toBe(false);
      expect(String(m.sourceUrl)).toMatch(/^https:\/\/www\.sportscardchecklist\.com\/set-\d+\//);
    });
  });

  it("every staged file is registered in the ingest universe with its staged path", () => {
    const universe = JSON.parse(
      readFileSync(join(__dirname, "..", "data", "ingest-universe.json"), "utf8"),
    ) as { entries: Array<Record<string, unknown>> };
    for (const s of STAGED) {
      const e = universe.entries.find((x) => x.stagedCsv === `backend/data/checklists/scraped/${s.file}.csv`);
      expect(e, `${s.file} must have a universe entry`).toBeTruthy();
      expect(e!.setKey).toBe(s.setKey);
      expect(e!.estimatedCards).toBe(s.cards);
      expect(e!.seededStatus).toBe("pending");
      expect(String(e!.sourceRef)).toMatch(/^https:\/\/www\.sportscardchecklist\.com\//);
    }
  });

  it("1990 and 1991 Fleer Glossy are NOT staged — Fleer stopped after 1989", () => {
    // Absent beats wrong. The task proposed 1987-1991 by analogy with Topps
    // Tiffany; the Glossy Tin ran 1987-1989 only, and the source serves no
    // 1990/1991 page. Minting one would be a synthetic product.
    for (const y of [1990, 1991]) {
      expect(existsSync(join(SCRAPED, `${y}-fleer-glossy-baseball.csv`)), `${y} must not exist`).toBe(false);
    }
  });
});
