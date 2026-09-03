/**
 * CF-THE-H3-IS-A-PRODUCT-BOUNDARY (D33, Drew 2026-08-30: "still a mess" on
 * the 2020 Bowman Draft BD-152 picker).
 *
 * The Parallels section is not one ladder. Its h3 headings open DIFFERENT
 * PRODUCTS -- Chrome, 1st Edition, Sapphire Edition -- each with its own card
 * numbering. The converter used to flatten all of them into one Map and
 * cross-join that over the paper base cards, so BD-152 (paper) carried Gold
 * Refractor /50, Padparadscha and SuperFractor: 38 rungs where the paper
 * ladder has 9.
 *
 * Fixtures are the REAL pages fetched 2026-08-30, trimmed to the body plus
 * the comc image URLs (the page's own machine-readable product/number map).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { qualifiedSetKeyFromTitle } from "../src/services/catalog/productQualifiers.js";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));
// CF-CHRONIC-REDS-DIST (2026-09-03). Was `require_("../dist/services/catalog/
// productQualifiers.js")`, which made this suite fail at import on any clone
// that had not run `npm run build`. Unlike the ops-script suites, nothing here
// tests the compiled artifact: qualifiedSetKeyFromTitle is used purely as a
// helper to express what the BCP ladder guard should decide. The contract under
// test is the guard's behaviour, so the source module is the honest import.
// Same assertions, same inputs, same expected values.
const qualify = (setKey: string, title: string) => qualifiedSetKeyFromTitle(setKey, title);

const fixture = (n: string) => fs.readFileSync(path.resolve(__dirname, `fixtures/bcp/${n}.trimmed.html`), "utf8");

function scopesOf(name: string, setName: string, setKey: string) {
  const html = fixture(name);
  const par = L.section(html, "Parallels", 2);
  return {
    html,
    cards: L.parseCards(L.section(html, "Base_Set", 2)),
    scopes: L.parseScopedLadders(par, { html, setName, setKey, qualify }),
  };
}
const named = (scopes: any[], title: string | null) => scopes.find((s: any) => s.title === title);
const rungNames = (s: any) => s.rungs.map((r: any) => r.name);

describe("2020 Bowman Draft — the paper scope is only the border ladder", () => {
  const { scopes } = scopesOf("2020-bowman-draft", "Bowman Draft", "bowman-draft");

  it("yields exactly the 9 paper border rungs", () => {
    const paper = named(scopes, null);
    expect(rungNames(paper)).toEqual([
      "Sky Blue", "Purple", "Blue", "Green", "Gold", "Orange", "Red", "Black", "Printing Plates",
    ]);
    expect(paper.rungs).toHaveLength(9);
  });

  it("keeps Refractor / Sapphire / 1st Edition OUT of the paper scope", () => {
    const paper = rungNames(named(scopes, null)).join(" | ");
    expect(paper).not.toMatch(/Refractor/i);
    expect(paper).not.toMatch(/Sapphire/i);
    expect(paper).not.toMatch(/1st Edition/i);
  });

  it("gives the Chrome scope its own 11 refractor rungs", () => {
    const chrome = named(scopes, "Chrome");
    expect(chrome.rungs).toHaveLength(11);
    expect(rungNames(chrome)).toContain("Gold Refractor");
    expect(rungNames(chrome)).toContain("SuperFractor");
  });

  it("routes 1st Edition and Sapphire to their own products (D22/D23 vocabulary)", () => {
    expect(named(scopes, "1st Edition").setKey).toBe("bowman-draft-1st-edition");
    expect(named(scopes, "Sapphire Edition").setKey).toBe("bowman-draft-sapphire");
    expect(named(scopes, "1st Edition").isOwnProduct).toBe(true);
    expect(named(scopes, "Sapphire Edition").isOwnProduct).toBe(true);
  });

  it("strips the product words from a qualified scope's parallel names", () => {
    // "1st Edition Blue" is the flat page's spelling. Once the row carries
    // setKey bowman-draft-1st-edition the edition IS the product.
    expect(L.rungNameInScope("1st Edition Blue", "1st Edition")).toBe("Blue");
    expect(L.rungNameInScope("1st Edition Gold", "1st Edition")).toBe("Gold");
    // and a name that merely starts with the same letters is untouched
    expect(L.rungNameInScope("Blues Clues", "Blue")).toBe("Blues Clues");
  });

  it("D31: paper Blue /150 and chrome Blue Refractor /150 stay two different cards", () => {
    const paperBlue = named(scopes, null).rungs.find((r: any) => r.name === "Blue");
    const chromeBlue = named(scopes, "Chrome").rungs.find((r: any) => r.name === "Blue Refractor");
    expect(paperBlue.printRun).toBe(150);
    expect(chromeBlue.printRun).toBe(150);
    // Same print run, different cards: the names must NOT be folded together.
    expect(paperBlue.name).not.toBe(chromeBlue.name);
  });
});

describe("the card-number prefix is DERIVED from the page, never assumed", () => {
  it("2020 Bowman Draft chrome is BD-, not BDC- (the brief's assumption was wrong)", () => {
    // The page's own images are Bowman-Draft---Chrome/BD-113, and Cardboard
    // Connection confirms BD-152 IS the 2020 chrome number. A hardcoded
    // BD->BDC mapping fails this test, which is the point of it.
    const { scopes } = scopesOf("2020-bowman-draft", "Bowman Draft", "bowman-draft");
    const chrome = named(scopes, "Chrome");
    expect(chrome.prefix).toBe("BD-");
    expect(chrome.prefix).not.toBe("BDC-");
  });

  it("2025 Bowman Draft chrome is BDC-, from the page's own card list", () => {
    // Different YEAR, different prefix, same converter and no hardcoding:
    // the 2025 page carries <li>BDC-1 Eli Willits</li> inside its Chrome h3.
    const { scopes } = scopesOf("2025-bowman-draft", "Bowman Draft", "bowman-draft");
    const chrome = named(scopes, "Chrome");
    expect(chrome.prefix).toBe("BDC-");
    expect(chrome.prefixVia).toBe("scope-cards");
  });

  it("2020 Bowman reads BFE- out of the page's PROSE", () => {
    // '1st Edition cards are sequentially-numbered with a "BFE-" prefix'
    const { scopes } = scopesOf("2020-bowman", "Bowman", "bowman");
    const first = named(scopes, "1st Edition Prospects");
    expect(first.prefix).toBe("BFE-");
    expect(first.prefixVia).toBe("prose");
  });

  it("2020 Bowman reads BP- and BCP- out of the comc image URLs alone", () => {
    const html = fixture("2020-bowman");
    const byPath = L.prefixesFromImages(html);
    expect(byPath.get("bowman---prospects")).toBe("BP-");
    expect(byPath.get("bowman---chrome-prospects")).toBe("BCP-");
  });

  it("an unresolvable prefix is reported, never guessed", () => {
    // No prose, no images, no card list -> null + "unresolved". The converter
    // then keeps the paper numbers under the scope's own setKey and prints
    // PREFIX UNRESOLVED rather than inventing a number that does not exist.
    const synthetic = '<h2 id="Parallels"><h3 id="Mystery_Edition"><ul><li>Gold (numbered to 50)</li><li>Red</li></ul>';
    const scopes = L.parseScopedLadders(synthetic, {
      html: synthetic, setName: "Bowman Draft", setKey: "bowman-draft", qualify,
    });
    const mystery = named(scopes, "Mystery Edition");
    expect(mystery.prefix).toBeNull();
    expect(mystery.prefixVia).toBe("unresolved");
  });
});

describe("a refused product move is a ruling, not a silent re-route", () => {
  it("bowman + Chrome Prospects stays under bowman and carries the refusal", () => {
    // productQualifiers REFUSES bowman -> bowman-chrome (the bcp-125 NEEDS
    // DREW family ruling). A scraper does not overrule a vocabulary decision.
    const { scopes } = scopesOf("2020-bowman", "Bowman", "bowman");
    const cp = named(scopes, "Chrome Prospects");
    expect(cp.setKey).toBe("bowman");
    expect(cp.isOwnProduct).toBe(false);
    expect(cp.refused?.[0]?.qualifier).toBe("Chrome");
    // but its NUMBERING is still the chrome one, read off the page
    expect(cp.prefix).toBe("BCP-");
  });

  it("a finish scope (Camo Prospects) stays a parallel of its paper parent", () => {
    const { scopes } = scopesOf("2020-bowman", "Bowman", "bowman");
    const camo = named(scopes, "Camo Prospects");
    expect(camo.setKey).toBe("bowman");
    expect(camo.isOwnProduct).toBe(false);
  });
});

describe("a scope's rungs stop at its own nested subsections", () => {
  it("2025 Chrome does not absorb Geometric / Etched in Glass / Chrome Gimmicks", () => {
    const { scopes } = scopesOf("2025-bowman-draft", "Bowman Draft", "bowman-draft");
    const chrome = named(scopes, "Chrome");
    const names = rungNames(chrome).join(" | ");
    expect(names).not.toMatch(/Geometric/i);
    expect(names).not.toMatch(/Etched in Glass/i);
    expect(chrome.rungs).toHaveLength(24);
  });
});
