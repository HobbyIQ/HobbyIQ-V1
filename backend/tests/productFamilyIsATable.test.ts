/**
 * CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling c): the product family is read
 * from a table, never derived from a string prefix of the setKey.
 *
 * Before D23 three places spelled the family as a string accident:
 *   productFamily.service   split("-").slice(0, 2)      -> the first two segments
 *   catalogMatcher step 3   split("-").slice(0, 2)      -> the same
 *   referenceCatalogLookup  lastIndexOf("-") peel + KNOWN_SUBSET_TO_BRAND
 *   deriveParentSetKey      startsWith("topps-") -> "topps"
 * and each of them made `topps-series-1` a sibling of `topps-sapphire`, could
 * not say that `bowman-draft-1st-edition` is another set, and read an unknown
 * `mystery-chrome-update` as a refinement of a `mystery-chrome` nobody named.
 *
 * Two nets, so a regression in either shape is red:
 *   1. behaviour — a key the table does not know is its own family, has no
 *      parent and widens into nothing (a prefix implementation answers
 *      "mystery-chrome" / "topps" / something);
 *   2. source — the family modules contain none of the prefix idioms.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { deriveParentSetKey, vocabularyDestinations } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { parseProductFamily, productFamilyKey, sameProductFamily, siblingsOfParent } from "../src/services/portfolioiq/productFamily.service.js";
import { widenedSetKeys } from "../src/services/catalog/catalogMatcher.service.js";
import {
  PRODUCT_SET_KEYS,
  productAncestry,
  productEntry,
  productFamilyOf,
  productParentOf,
  productRefinementsOf,
  productSetKeys,
} from "../src/services/catalog/productSetKeys.js";

const SRC = path.join(__dirname, "..", "src", "services");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const stripComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("an unknown key is its own family (behaviour)", () => {
  it("a key the table does not know crosses nothing, has no parent, widens into nothing", () => {
    expect(productFamilyKey("mystery-chrome-update")).toBe("mystery-chrome-update");
    expect(sameProductFamily("mystery-chrome-update", "mystery-chrome")).toBe(false);
    expect(sameProductFamily("mystery-chrome-update", "mystery")).toBe(false);
    expect(deriveParentSetKey("topps-mystery")).toBeNull();
    expect(deriveParentSetKey("bowman-mystery-chrome")).toBeNull();
    expect(productParentOf("panini-mystery")).toBeNull();
    expect(productAncestry("mystery-chrome-update")).toEqual(["mystery-chrome-update"]);
    expect(productRefinementsOf("mystery")).toEqual([]);
    expect(widenedSetKeys("mystery")).toEqual([]);
    expect(parseProductFamily("mystery-chrome-update")).toMatchObject({ parent: "mystery-chrome-update", subproduct: "", hierarchy: ["mystery-chrome-update"] });
  });

  it("a known key's family, parent and ancestry are the table's, including through a legacy spelling", () => {
    expect(productFamilyOf("bowman-chrome-prospects")).toBe("bowman-chrome");
    expect(productFamilyOf("topps-update")).toBe("topps");
    expect(productAncestry("topps-chrome-update")).toEqual(["topps-chrome-update", "topps-chrome-update-series", "topps-chrome", "topps"]);
    expect(productAncestry("bowman-chrome-sapphire")).toEqual(["bowman-chrome-sapphire", "bowman-chrome", "bowman"]);
    expect(productAncestry("topps-traded-tiffany")).toEqual(["topps-traded-tiffany", "topps-traded", "topps"]);
    expect(productAncestry("panini-prizm")).toEqual(["panini-prizm", "panini"]);
    expect(siblingsOfParent("topps", ["topps", "topps-series-1", "topps-chrome", "topps-update", "bowman"])).toEqual(["topps", "topps-series-1", "topps-chrome", "topps-update"]);
  });

  it("the pins the cross-setkey rung was built on still hold", () => {
    for (const [a, b, want] of [
      ["bowman-chrome-prospects", "bowman-chrome", true],
      ["bowman-chrome-updates", "bowman-chrome", true],
      ["bowman-chrome-mega-box", "bowman-chrome-prospects", true],
      ["topps-chrome-update", "topps-chrome", true],
      ["bowman-draft-chrome", "bowman-draft", true],
      ["bowman", "bowman-chrome", false],
      ["topps", "topps-chrome", false],
      ["bowman", "bowman-draft", false],
      ["bowman-chrome-sapphire", "bowman-chrome", false],
      ["bowman-draft-sapphire", "bowman-draft", false],
      ["topps-chrome-sapphire", "topps-chrome", false],
      ["bowman-sterling", "bowman-chrome", false],
      ["panini-prizm", "panini-select", false],
    ] as Array<[string, string, boolean]>) {
      expect(sameProductFamily(a, b), `${a} ~ ${b}`).toBe(want);
    }
  });
});

describe("the table is whole", () => {
  it("every key the regex vocabulary can emit has a family entry", () => {
    const missing = vocabularyDestinations().filter((k) => !productEntry(k));
    expect(missing, "vocabulary destinations the product table does not know").toEqual([]);
  });

  it("no key is spelled twice, and no name points at two products", () => {
    const keys = productSetKeys();
    expect(new Set(keys).size).toBe(keys.length);
    const names = new Map<string, string>();
    for (const p of PRODUCT_SET_KEYS) {
      for (const n of [p.setKey, ...(p.names ?? [])]) {
        expect(names.get(n) ?? p.setKey, `"${n}" names two products`).toBe(p.setKey);
        names.set(n, p.setKey);
      }
    }
  });

  it("every family, parent and refinement names a key the table spells", () => {
    const keys = new Set(productSetKeys());
    for (const p of PRODUCT_SET_KEYS) {
      if (p.family) expect(keys.has(p.family), `${p.setKey}.family = ${p.family}`).toBe(true);
      if (p.parent) expect(keys.has(p.parent), `${p.setKey}.parent = ${p.parent}`).toBe(true);
      if (p.refines) expect(keys.has(p.refines), `${p.setKey}.refines = ${p.refines}`).toBe(true);
    }
  });
});

describe("no code path derives the family from a prefix (source)", () => {
  const PREFIX_IDIOMS: Array<[string, RegExp]> = [
    ["the first two segments", /\.split\(\s*["']-["']\s*\)\s*(?:\.filter\([^)]*\)\s*)?\.slice\(\s*0\s*,\s*2\s*\)/],
    ["segments.slice(0, 2)", /segments\.slice\(\s*0\s*,\s*2\s*\)/],
    ["peeling the last segment", /lastIndexOf\(\s*["']-["']\s*\)/],
    ["a brand-prefix startsWith", /startsWith\(\s*["'](?:topps|bowman|panini|upper-deck|fleer|leaf|donruss|pinnacle|skybox)-["']\s*\)/],
    ["a `${parent}-` prefix", /startsWith\(\s*`\$\{[a-zA-Z]+\}-`\s*\)/],
  ];
  const FAMILY_MODULES = [
    "portfolioiq/productFamily.service.ts",
    "portfolioiq/crossSetKeyRule.ts",
    "catalog/catalogMatcher.service.ts",
    "compiq/referenceCatalogLookup.ts",
    "catalog/productSetKeys.ts",
  ];

  it.each(FAMILY_MODULES)("%s", (rel) => {
    const src = stripComments(read(rel));
    for (const [what, re] of PREFIX_IDIOMS) {
      expect(re.test(src), `${rel} derives a family by ${what}`).toBe(false);
    }
  });

  it("deriveParentSetKey reads the table, not a prefix", () => {
    const src = stripComments(read("portfolioiq/hobbyIqCardId.service.ts"));
    const m = /export function deriveParentSetKey[\s\S]*?\n\}/.exec(src);
    expect(m, "deriveParentSetKey not found").not.toBeNull();
    const body = m![0];
    expect(body).toContain("productParentOf(");
    for (const [what, re] of PREFIX_IDIOMS) expect(re.test(body), `deriveParentSetKey derives a parent by ${what}`).toBe(false);
  });

  it("the reference ladder's brand maps are gone", () => {
    const src = stripComments(read("compiq/referenceCatalogLookup.ts"));
    expect(src).not.toContain("KNOWN_SUBSET_TO_BRAND");
    expect(src).not.toContain("KNOWN_BRAND_ROOTS");
    expect(src).toContain("productAncestry(");
  });
});
