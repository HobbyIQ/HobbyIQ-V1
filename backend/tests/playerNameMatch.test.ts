/**
 * CF-PLAYER-NAME-PRODUCT-VOCAB (2026-08-23).
 *
 * The accent fold shipped in #1216 was expected to recover a large number of
 * Tiffany and Topps Traded sales on a re-run. It recovered 14. Classifying the
 * rejections instead of assuming their cause showed the real blocker: a sale's
 * playerName carries the SET NAME and seller condition vocabulary that the
 * catalog's does not.
 *
 *   1,050 of 1,669 Topps Traded rejects   "Traded Kent Hrbek" || "Kent Hrbek"
 *      98 of   612 Tiffany rejects        "Ed Romero Collector 's" || "Ed Romero"
 *
 * "traded" alone accounts for 1,035 of them.
 *
 * THE NEGATIVE CASES ARE THE POINT, and they are why this is a vocabulary
 * addition and not a subset or fuzzy rule. A subset rule would have recovered
 * the same rows AND silently merged "Cal Ripken" into "Cal Ripken, Jr." — 202
 * rows across the two sweeps sit in exactly that shape. Every one of them must
 * still be refused after this change.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { DESIGNATION, normPlayerName, samePlayer } = require("../scripts/comp-quality/playerNameMatch.cjs");

describe("product and condition vocabulary is stripped from a player name", () => {
  it("matches names that differ only by the set name or seller noise", () => {
    const pairs: Array<[string, string, string]> = [
      ["Traded Kent Hrbek", "Kent Hrbek", "the set name, Topps Traded"],
      ["Traded Barry Bonds", "Barry Bonds XRC", "set name on one side, card status on the other"],
      ["Traded Greg Maddux Xrc", "Greg Maddux XRC", "both designations at once"],
      ["Ed Romero Collector 's", "Ed Romero", "packaging, with a split possessive"],
      ["Tony Oliva Collector's", "Tony Oliva", "packaging, possessive unsplit"],
      ["Jim Abbott", "Jim Abbott OLY XRC", "Olympic designation on the catalog side"],
      ["Nolan Ryan NM MT", "Nolan Ryan", "condition written into the name field"],
      ["Kirby Puckett Near Mint", "Kirby Puckett", "condition spelled out"],
    ];
    for (const [sale, catalog, why] of pairs) {
      expect(samePlayer(sale, catalog), `${sale} || ${catalog} — ${why}`).toBe(true);
    }
  });

  it("still folds accents — the #1216 fix must not regress", () => {
    expect(samePlayer("Luis Peña", "Luis Pena")).toBe(true);
    expect(samePlayer("Ronald Acuña Jr", "Ronald Acuna Jr")).toBe(true);
  });
});

describe("the guard still refuses everything it was built to refuse", () => {
  it("never collapses a generational suffix", () => {
    // 202 rows across the two sweeps are this exact shape. A subset rule would
    // have merged them; vocabulary stripping does not, because jr/sr are not
    // in the list and never will be.
    expect(samePlayer("Cal Ripken", "Cal Ripken, Jr.")).toBe(false);
    expect(samePlayer("Ken Griffey", "Ken Griffey Jr")).toBe(false);
    expect(samePlayer("Traded Cal Ripken", "Cal Ripken, Sr.")).toBe(false);
    expect(samePlayer("Mel Stottlemyre", "Mel Stottlemyre, Jr.")).toBe(false);
  });

  it("never matches two different people", () => {
    // The real mismatch this guard caught: 1989 Topps #6 is Pedro Guerrero, not
    // Doug Jones. Base sets and their Traded counterparts both number from 1.
    expect(samePlayer("Doug Jones", "Pedro Guerrero")).toBe(false);
    expect(samePlayer("Frank Viola", "Dave Righetti")).toBe(false);
    expect(samePlayer("Traded Ken Griffey Jr", "Larry McWilliams")).toBe(false);
    expect(samePlayer("Bert Blyleven", "Kent Hrbek")).toBe(false);
  });

  it("does not let a stripped-down set label land on a player", () => {
    // "Traded Tiffany Collectors Set" is a product, not a person. Stripping its
    // packaging words must not leave something that matches whoever happens to
    // sit at that card number.
    expect(samePlayer("Traded Tiffany Collectors Set", "Fred Lynn")).toBe(false);
    expect(samePlayer("Traded Box Set Collector", "Bob Ojeda")).toBe(false);
  });

  it("keeps Operation Desert Shield off the Tiffany card", () => {
    // A DIFFERENT product line, not noise. If "operation"/"desert" were ever
    // added to the strip list these would start matching and Desert Shield
    // sales would be filed as Tiffany — the conflation the sweeps undo.
    expect(samePlayer("Trevor Wilson Operation Desert", "Trevor Wilson")).toBe(false);
    expect(samePlayer("Jeff Kaiser Operation Desert", "Jeff Kaiser")).toBe(false);
  });

  it("does not treat a nickname or a truncation as the same person", () => {
    expect(samePlayer("Denny Martinez Collector 's", "Dennis Martinez")).toBe(false);
    expect(samePlayer("Pack Fresh Traded Barry", "Barry Bonds XRC")).toBe(false);
  });

  it("treats an unverifiable name as unverifiable, not as a match", () => {
    expect(samePlayer("", "Kent Hrbek")).toBe(false);
    expect(samePlayer("Traded Collectors Set", "Traded Collectors Set")).toBe(false);
    expect(samePlayer(null, null)).toBe(false);
  });
});

describe("the possessive strip does not damage real names", () => {
  it("leaves an apostrophe that is part of the name alone", () => {
    expect(normPlayerName("Sean O'Shea")).toBe("seanoshea");
    expect(samePlayer("Sean O'Shea", "Sean OShea")).toBe(true);
    expect(samePlayer("Sean O'Shea", "Sean O")).toBe(false);
  });

  it("removes only a trailing possessive", () => {
    expect(normPlayerName("Collector's")).toBe("");
    expect(normPlayerName("Collector 's")).toBe("");
  });
});

describe("structural pins", () => {
  it("keeps generational suffixes out of the strip list", () => {
    for (const t of ["jr", "sr", "ii", "iii"]) {
      expect(DESIGNATION.has(t), `${t} must never be a designation`).toBe(false);
    }
  });

  it("keeps words that are also product lines or people out of the strip list", () => {
    for (const t of ["tiffany", "operation", "desert", "sapphire", "chrome"]) {
      expect(DESIGNATION.has(t), `${t} names a product or a person, not a designation`).toBe(false);
    }
  });
});
