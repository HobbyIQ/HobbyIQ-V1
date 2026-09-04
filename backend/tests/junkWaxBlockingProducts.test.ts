/**
 * CF-THE-1990S-BASEBALL-PRODUCTS-THE-REMATCH-COULD-NOT-PLACE (2026-09-04,
 * IMPROVE gate audit of #1758).
 *
 * ~61k 1990s baseball sales cannot be placed because the products they name
 * hold ZERO card_catalog rows, so every one refuses on L1 with nothing to match
 * against. This file pins the acquisition, and the three defects that had to be
 * fixed for the staged checklists to mean anything -- each by a mutation that
 * goes red:
 *
 *   1. THE CATALOG ALREADY HAD A SPELLING, AND THE AUDIT NAMED THE OTHER ONE.
 *      The task listed `upper-deck-sp`, `upper-deck-sp-championship`,
 *      `upper-deck-minor-league` and `pacific-prisms`. Every one is wrong:
 *      sampled on 2026-09-04, `sp` holds 300/300 baseballcardpedia-backed rows
 *      at 1993-1997, `upper-deck-minors` 300/300 at 1992/1994/1995, and
 *      `pacific-prism` 285/300 -- while the rival spellings hold ONE stray
 *      sales-attested row each. Staging the audit's spelling would have minted
 *      a SECOND product beside a populated one and split every pool this work
 *      exists to fill. The staged manifests are pinned to the catalog's
 *      spelling, so a re-stage under the slug's spelling goes red.
 *
 *   2. THE FETCHER REPARENTED TWO OF THEM. #1741 rules that a page extending a
 *      known brand belongs to that brand -- right for an insert with no pool of
 *      its own, wrong for a separately-issued product. Measured on the shipped
 *      fetcher, `--set-key score-rookie-and-traded` came back as `score` with
 *      subset "Rookie And Traded", and `upper-deck-minors` as `upper-deck` with
 *      subset "Minors": two products folded onto their flagships at colliding
 *      card numbers. Pinned in BOTH directions, so the real inserts still
 *      reparent.
 *
 *   3. A RULED KEY MUST BE A normalizeSetKey FIXED POINT, asserted by RUNNING
 *      the function rather than reading the table -- the #1748 lesson, whose
 *      `P` declarations still collapsed because only a `spelled` product
 *      answers productSetKeyForName.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { splitParentAndSubset } = require("../scripts/fetchSportsCardChecklist.cjs");

const SCRAPED = join(__dirname, "..", "data", "checklists", "scraped");

/** The products this acquisition stages, and the parent each nests under. */
const PRODUCTS: ReadonlyArray<{ key: string; parent: string }> = [
  { key: "pacific-prism", parent: "pacific" },
  { key: "pacific-crown-collection", parent: "pacific" },
  { key: "pacific-gold-crown-die-cuts", parent: "pacific" },
  { key: "sp", parent: "upper-deck" },
  { key: "sp-championship", parent: "upper-deck" },
  { key: "upper-deck-minors", parent: "upper-deck" },
  { key: "score-rookie-and-traded", parent: "score" },
];

/**
 * Every staged file with the count the fetch verified against BOTH page anchors.
 * A number here that stops matching the CSV means the file changed under us --
 * the only way a 450-card set silently becomes 449.
 */
const STAGED: ReadonlyArray<{ file: string; key: string; cards: number }> = [
  { file: "1995-pacific-prism-baseball", key: "pacific-prism", cards: 146 },
  { file: "1996-pacific-prism-baseball", key: "pacific-prism", cards: 144 },
  { file: "1997-pacific-prism-baseball", key: "pacific-prism", cards: 150 },
  { file: "1996-pacific-prism-gold-baseball", key: "pacific-prism", cards: 144 },
  { file: "1997-pacific-prism-light-blue-baseball", key: "pacific-prism", cards: 150 },
  { file: "1997-pacific-prism-platinum-baseball", key: "pacific-prism", cards: 150 },
  { file: "1996-pacific-crown-collection-baseball", key: "pacific-crown-collection", cards: 450 },
  { file: "1997-pacific-crown-collection-baseball", key: "pacific-crown-collection", cards: 450 },
  { file: "1999-pacific-crown-collection-baseball", key: "pacific-crown-collection", cards: 301 },
  { file: "1997-pacific-crown-collection-silver-baseball", key: "pacific-crown-collection", cards: 450 },
  { file: "1997-pacific-crown-collection-light-blue-baseball", key: "pacific-crown-collection", cards: 450 },
  { file: "1995-pacific-gold-crown-die-cuts-baseball", key: "pacific-gold-crown-die-cuts", cards: 20 },
  { file: "1998-pacific-gold-crown-die-cuts-baseball", key: "pacific-gold-crown-die-cuts", cards: 36 },
  { file: "1999-pacific-gold-crown-die-cuts-baseball", key: "pacific-gold-crown-die-cuts", cards: 36 },
  { file: "1993-sp-baseball", key: "sp", cards: 290 },
  { file: "1994-sp-baseball", key: "sp", cards: 201 },
  { file: "1995-sp-baseball", key: "sp", cards: 210 },
  { file: "1996-sp-baseball", key: "sp", cards: 188 },
  { file: "1997-sp-baseball", key: "sp", cards: 184 },
  { file: "1995-sp-championship-baseball", key: "sp-championship", cards: 202 },
  { file: "1992-upper-deck-minors-baseball", key: "upper-deck-minors", cards: 330 },
  { file: "1994-upper-deck-minors-baseball", key: "upper-deck-minors", cards: 270 },
  { file: "1995-upper-deck-minors-baseball", key: "upper-deck-minors", cards: 225 },
  { file: "1990-score-rookie-and-traded-baseball", key: "score-rookie-and-traded", cards: 110 },
  { file: "1991-score-rookie-and-traded-baseball", key: "score-rookie-and-traded", cards: 110 },
  { file: "1992-score-rookie-and-traded-baseball", key: "score-rookie-and-traded", cards: 110 },
  { file: "1994-score-rookie-and-traded-baseball", key: "score-rookie-and-traded", cards: 165 },
  { file: "1998-score-rookie-and-traded-baseball", key: "score-rookie-and-traded", cards: 271 },
  { file: "1996-metal-universe-baseball", key: "metal-universe", cards: 250 },
  { file: "1997-metal-universe-baseball", key: "metal-universe", cards: 250 },
  { file: "1998-metal-universe-baseball", key: "metal-universe", cards: 221 },
];

describe("the 1990s baseball products the rematch could not place", () => {
  it("every ruled key is a normalizeSetKey FIXED POINT", () => {
    // Asserting the FUNCTION's output, never the table's contents: #1748's `P`
    // declarations were present in the table and still collapsed.
    for (const { key } of PRODUCTS) {
      expect(normalizeSetKey(key), `${key} must survive normalizeSetKey unchanged`).toBe(key);
    }
    expect(normalizeSetKey("metal-universe")).toBe("metal-universe");
    expect(normalizeSetKey("uc3")).toBe("uc3");
  });

  it("every ruled key is a declared product with the stated parent", () => {
    for (const { key, parent } of PRODUCTS) {
      expect(isProductSetKey(key), `${key} must be a declared product`).toBe(true);
      expect(productParentOf(key), `${key} must nest under ${parent}`).toBe(parent);
    }
  });

  /**
   * THE SPELLING THE AUDIT PROPOSED IS NOT THE SPELLING THE CATALOG USES. These
   * four are the wrong side of a populated/empty split, measured in Cosmos on
   * 2026-09-04. Declaring any of them as a product of its own is what would
   * re-split the pools, so their ABSENCE from the product table is the pin.
   */
  it("the audit's slug spellings are NOT minted as rival products", () => {
    for (const wrong of ["upper-deck-sp", "upper-deck-sp-championship", "upper-deck-minor-league", "pacific-prisms"]) {
      expect(isProductSetKey(wrong), `${wrong} must NOT be a product — the catalog spells it otherwise`).toBe(false);
    }
  });

  /**
   * A SEPARATELY-ISSUED PRODUCT IS NOT A SUBSET OF ITS BRAND. Both directions,
   * so the narrow guard cannot widen into "nothing ever reparents".
   */
  it("a ruled product keeps its own key; a real insert still reparents", () => {
    // The two the shipped fetcher folded onto their flagships.
    expect(splitParentAndSubset("score-rookie-and-traded", null)).toEqual({ parentSetKey: "", subset: "" });
    expect(splitParentAndSubset("upper-deck-minors", null)).toEqual({ parentSetKey: "", subset: "" });
    // ...and the #1741 behaviour this must not break.
    expect(splitParentAndSubset("topps-chrome-cards-that-never-were", null))
      .toEqual({ parentSetKey: "topps-chrome", subset: "Cards That Never Were" });
  });

  it("every staged file exists, is the one CSV format, and holds the verified card count", () => {
    for (const { file, key, cards } of STAGED) {
      const csv = join(SCRAPED, `${file}.csv`);
      const manifest = join(SCRAPED, `${file}.manifest.json`);
      expect(existsSync(csv), `${file}.csv must be staged`).toBe(true);
      expect(existsSync(manifest), `${file}.manifest.json must be staged`).toBe(true);

      const lines = readFileSync(csv, "utf8").trim().split("\n");
      expect(lines[0]).toBe("category,cardNumber,parallel,isAuto,printRun,player,parallelNote,rarity");
      expect(lines.length - 1, `${file} card count`).toBe(cards);

      const m = JSON.parse(readFileSync(manifest, "utf8"));
      expect(m.setKey, `${file} must be keyed to the catalog's spelling`).toBe(key);
      // The requested key survived: nothing reparented it on the way out.
      expect(m.setKey, `${file} was reparented`).toBe(m.setKeyRequested);
      expect(m.rowCount).toBe(cards);
      expect(m.source).toBe("sportscardchecklist");
    }
  });

  /**
   * NO PRINT RUN IS INVENTED. The pages state none, and a well-formed wrong
   * print run splits a comp pool where no only-improve pass can ever see it.
   */
  it("no staged row carries a guessed print run", () => {
    for (const { file } of STAGED) {
      const lines = readFileSync(join(SCRAPED, `${file}.csv`), "utf8").trim().split("\n").slice(1);
      for (const line of lines) {
        const printRun = line.split(",")[4];
        expect(printRun, `${file} must not invent a print run`).toBe("");
      }
    }
  });

  /**
   * THE PARALLEL COLUMN IS THE SLUG'S OWN WORD OR IT IS BLANK. `1997 Pacific
   * Prism Light Blue` and `... Platinum` are rungs this source names but
   * SLUG_PARALLEL_TAIL does not recognise, and they stage BLANK rather than
   * guessed -- blank means unknown, and a guessed rung is worse than no rung.
   */
  it("a parallel is the slug's own word, never synthesised", () => {
    const parallelsOf = (file: string) =>
      new Set(readFileSync(join(SCRAPED, `${file}.csv`), "utf8").trim().split("\n").slice(1)
        .map((l) => l.split(",")[2]));
    expect(parallelsOf("1996-pacific-prism-gold-baseball")).toEqual(new Set(["Gold"]));
    expect(parallelsOf("1997-pacific-crown-collection-silver-baseball")).toEqual(new Set(["Silver"]));
    // Unrecognised rungs stay blank rather than becoming a minted finish.
    expect(parallelsOf("1997-pacific-prism-platinum-baseball")).toEqual(new Set([""]));
  });

  /**
   * ABSENCE IS A FINDING, NOT A GAP. Two of the twelve products the audit named
   * are NOT served by this source, verified against the whole 141,482-URL
   * sitemap: there is no `uc3` slug anywhere on it (1995 Pinnacle/Sportflix UC3
   * is real -- the catalog holds 246 baseballcardpedia-backed rows -- but this
   * lane cannot reach it), and no 1990s `topps-mini` baseball set exists beyond
   * `1990-topps-mini-leaders`. Minting either from a name would be the
   * synthetic row this lane refuses, so their absence is pinned instead.
   */
  it("the two products this source does not serve are NOT staged", () => {
    for (const { file } of STAGED) {
      expect(file).not.toMatch(/uc3|topps-mini/);
    }
  });
});
