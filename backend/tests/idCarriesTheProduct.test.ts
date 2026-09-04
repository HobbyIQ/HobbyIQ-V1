/**
 * CF-THE-ID-CARRIES-THE-PRODUCT (D23; Drew, 2026-08-30 19:50Z).
 *
 * "The id's setKey is the product as the checklist names it." Before D23 the
 * slug generator collapsed the product into its family — topps-series-1 →
 * topps, topps-update-series → topps-update, topps-chrome-update-series →
 * topps-chrome, bowman-draft-1st-edition → bowman-draft, upper-deck-series-1
 * → upper-deck, topps-heritage-high-number → topps-heritage, leaf-vivid /
 * leaf-metal → leaf — while the row's setKey field kept the product:
 * 1,231,457 un-graded catalog rows disagreed with their own id (measured
 * 2026-08-30), and the movers refused about half their rows on it.
 *
 * These pins are the mutation checks the ruling asks for:
 *   - re-introduce a collapse (a `/topps/` rule ahead of the table)  → red
 *   - make a card-number compare hyphen-sensitive                      → red
 *   - derive the family from a prefix (productFamilyIsATable.test.ts) → red
 */
import { describe, it, expect } from "vitest";
import {
  cardNumberInClause,
  cardNumberVariants,
  computeHobbyIqCardId,
  deriveParentSetKey,
  foldCardNumber,
  normalizeSetKey,
  resolveSetKeyForSlug,
  sameCardNumber,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service.js";
import { productFamilyKey, sameProductFamily } from "../src/services/portfolioiq/productFamily.service.js";
import { filterCrossSetKeyComps, foldPlayerName } from "../src/services/portfolioiq/crossSetKeyRule.js";
import { narrowToNamedProduct, PRODUCT_WORDS } from "../src/services/catalog/catalogSearch.service.js";
import { widenedSetKeys } from "../src/services/catalog/catalogMatcher.service.js";
import { qualifiedSetKeyFromTitle } from "../src/services/catalog/productQualifiers.js";
import {
  DONRUSS_SPELLING_POLICY,
  PANINI_DONRUSS_FROM_YEAR,
  productAncestry,
  productFamilyOf,
  productSetKeyForName,
  spellForEra,
} from "../src/services/catalog/productSetKeys.js";

const id = (setKey: string, year = 2024, cardNumber = "100", sport = "baseball") =>
  computeHobbyIqCardId({ sport, year, setKey, cardNumber, parallel: "Base", isAuto: false, printRun: null });
const seg = (slug: string) => slug.split(":")[3];

describe("the id carries the product as the checklist names it (ruling a)", () => {
  it.each([
    // [checklist / seller text, the one spelling]
    ["2024 Topps Series 1 Baseball", "topps-series-1"],
    ["Topps Series One", "topps-series-1"],
    ["topps-series-1", "topps-series-1"],
    ["2024 Topps Series 2 Baseball", "topps-series-2"],
    ["Topps Series Two", "topps-series-2"],
    ["2024 Topps Series 1 Baseball 1st Edition", "topps-series-1-1st-edition"],
    ["2025 Topps Update Series Baseball", "topps-update-series"],
    ["2011 Topps Update", "topps-update-series"],
    ["topps-update", "topps-update-series"],
    ["2024 Topps Update Series Baseball Hobby Box", "topps-update-series"],
    ["2008 Topps Updates & Highlights", "topps-updates-and-highlights"],
    ["2024 Topps Chrome Update Series", "topps-chrome-update-series"],
    ["2022 Topps Chrome Update", "topps-chrome-update-series"],
    ["topps-chrome-update", "topps-chrome-update-series"],
    ["2020 Bowman Draft 1st Edition Baseball", "bowman-draft-1st-edition"],
    ["Bowman Draft First Edition", "bowman-draft-1st-edition"],
    ["1999 Upper Deck Series 1 Hockey", "upper-deck-series-1"],
    ["Upper Deck Series 2", "upper-deck-series-2"],
    ["2024 Topps Heritage High Number", "topps-heritage-high-number"],
    ["Topps Heritage High Numbers", "topps-heritage-high-number"],
    ["2025 Leaf Vivid Baseball", "leaf-vivid"],
    ["leaf-vivid-baseball", "leaf-vivid"],
    ["2026 Leaf Metal Baseball", "leaf-metal"],
    ["leaf-metal-baseball", "leaf-metal"],
    ["2022 Leaf Metal Draft", "leaf-metal-draft"],
    ["Leaf Trinity", "leaf-trinity"],
    ["2024 Leaf Optichrome Baseball", "leaf-optichrome"],
  ])("%s -> %s, in the id and in normalizeSetKey", (text, want) => {
    expect(normalizeSetKey(text)).toBe(want);
    expect(seg(id(text))).toBe(want);
  });

  it("the collapsed families stay reachable for the plain product only", () => {
    expect(normalizeSetKey("2024 Topps Baseball")).toBe("topps");
    expect(normalizeSetKey("2020 Bowman Draft")).toBe("bowman-draft");
    expect(normalizeSetKey("1999 Upper Deck")).toBe("upper-deck");
    expect(normalizeSetKey("2024 Topps Heritage")).toBe("topps-heritage");
    expect(normalizeSetKey("1994 Leaf")).toBe("leaf");
    expect(normalizeSetKey("2024 Topps Chrome")).toBe("topps-chrome");
  });

  it("1st Edition is another set: bowman-draft-1st-edition never shares an id with bowman-draft", () => {
    const first = id("2020 Bowman Draft 1st Edition", 2020, "BD-152");
    const plain = id("2020 Bowman Draft", 2020, "BD-152");
    expect(first).toBe("hiq:baseball:2020:bowman-draft-1st-edition:bd-152:base:no-auto");
    expect(plain).toBe("hiq:baseball:2020:bowman-draft:bd-152:base:no-auto");
    expect(first).not.toBe(plain);
  });

  it("the products the table does not touch keep their rulings", () => {
    expect(normalizeSetKey("2026 Bowman Chrome Prospects")).toBe("bowman-chrome");
    expect(normalizeSetKey("2025 Bowman Draft Chrome")).toBe("bowman-draft");           // CF-MATCH-THE-CATALOG
    expect(normalizeSetKey("2024 Topps Chrome Sapphire Edition")).toBe("topps-chrome-sapphire");
    expect(normalizeSetKey("2024 Topps Chrome Update Sapphire Edition")).toBe("topps-chrome-update-sapphire");
    expect(normalizeSetKey("2024 Topps Update Sapphire")).toBe("topps-update-sapphire");
    // D31 (Drew 2026-08-31): the table DOES spell Optic now -- one product,
    // donruss-optic. See opticIsOneProduct.test.ts for the full pin.
    expect(normalizeSetKey("2024 Donruss Optic")).toBe("donruss-optic");
    expect(normalizeSetKey("2024 Panini Prizm")).toBe("panini-prizm");
    expect(normalizeSetKey("Fleer Metal Universe")).toBe("fleer-metal-universe");
    expect(normalizeSetKey("2024 Topps Series 1 Celebration Mega Box")).toBe("topps-series-1-celebration-mega-box");
  });

  it("only the spelled products answer; the longest name wins; the rest is the vocabulary's", () => {
    expect(productSetKeyForName("topps-update")).toBe("topps-update-series");
    expect(productSetKeyForName("topps-update-sapphire")).toBe("topps-update-sapphire");        // longer than the alias
    expect(productSetKeyForName("topps-update-series-hobby-box")).toBe("topps-update-series");  // a segment run
    expect(productSetKeyForName("leaf-metal-draft")).toBe("leaf-metal-draft");                 // not leaf-metal
    // Family-only entries never pre-empt the vocabulary: the regex ordering
    // still folds "Bowman Chrome Prospects" and "Upper Deck SPx Finite".
    expect(productSetKeyForName("bowman-chrome-prospects")).toBeNull();
    expect(productSetKeyForName("upper-deck-spx-finite")).toBeNull();
    // D31: panini-donruss-optic is now a NAME of the spelled donruss-optic
    // product, so it answers -- it is no longer left to the vocabulary.
    expect(productSetKeyForName("panini-donruss-optic")).toBe("donruss-optic");
    expect(productSetKeyForName("donruss")).toBeNull();
    expect(productSetKeyForName("leaf")).toBeNull();
    expect(productSetKeyForName("leaf-something-new")).toBeNull();
  });

  // D36, Drew 2026-08-30: "the product is topps-finest (the product as Topps
  // names it), not finest". The bare-alias rule already minted topps-finest
  // for NEW ids; the TABLE is what the rename fleet reads, and until it
  // spelled the product the 58,442 baseballcardpedia rows still keyed
  // `finest` (against 221,498 already topps-finest, measured 2026-08-30) had
  // nothing to move them -- and Drew's Finest holdings could not reach the
  // checklist row hiq:baseball:1997:finest:238:base:no-auto.
  it("Finest is spelled topps-finest, and Flashbacks is its own product", () => {
    expect(productSetKeyForName("finest")).toBe("topps-finest");
    expect(productSetKeyForName("topps-finest")).toBe("topps-finest");
    // the longer name wins over the bare `finest` alias
    expect(productSetKeyForName("finest-flashbacks")).toBe("topps-finest-flashbacks");
    expect(productSetKeyForName("topps-finest-flashbacks")).toBe("topps-finest-flashbacks");
    // a single-segment name matches only exactly -- stripping the year is the
    // caller's job, not a substring match here
    expect(productSetKeyForName("1997-finest")).toBeNull();
    // the legacy spelling still prices within the product, and the walk reaches Topps
    expect(productFamilyOf("finest")).toBe("topps-finest");
    expect(productFamilyOf("topps-finest-flashbacks")).toBe("topps-finest");
    expect(productAncestry("finest")).toContain("topps-finest");
    expect(productAncestry("topps-finest")).toContain("topps");
  });
});

describe("the maker prefix is kept on Panini-era Donruss (ruling b)", () => {
  it("the policy is compile-time and defaults to the era", () => {
    expect(DONRUSS_SPELLING_POLICY).toBe("panini-era");
    expect(PANINI_DONRUSS_FROM_YEAR).toBe(2009);
  });

  it.each([
    ["Donruss", 1990, "donruss"],
    ["1990 Donruss", 1990, "donruss"],
    ["Panini Donruss", 2005, "donruss"],          // the field pollution the fleet heals
    ["Donruss", 2008, "donruss"],
    ["Donruss", 2009, "panini-donruss"],
    ["2025 Donruss Baseball", 2025, "panini-donruss"],
    ["2025 Panini Donruss Baseball", 2025, "panini-donruss"],
    ["donruss", 2025, "panini-donruss"],
  ])("%s in %d -> %s", (text, year, want) => {
    expect(resolveSetKeyForSlug("baseball", text, year)).toBe(want);
    expect(seg(id(text, year))).toBe(want);
  });

  it("the named alternative, as-named, lets the text decide in every year", () => {
    expect(spellForEra("donruss", 2025, "as-named")).toBe("donruss");
    expect(spellForEra("panini-donruss", 1990, "as-named")).toBe("panini-donruss");
    expect(spellForEra("donruss", 2025, "panini-era")).toBe("panini-donruss");
    expect(spellForEra("panini-donruss", 1990, "panini-era")).toBe("donruss");
    expect(spellForEra("topps", 1990, "panini-era")).toBe("topps");
    expect(spellForEra("donruss", null, "panini-era")).toBe("donruss");
  });

  it("Donruss Optic / Elite / Studio are their own products, untouched by the era rule", () => {
    // D31: Optic is spelled donruss-optic and, launching in 2016, is
    // Panini-era-only -- it needs no era boundary of its own.
    expect(resolveSetKeyForSlug("baseball", "2024 Donruss Optic", 2024)).toBe("donruss-optic");
    expect(resolveSetKeyForSlug("baseball", "2024 Donruss Elite", 2024)).toBe("donruss-elite");
    // CF-A-RULED-KEY-IS-A-FIXED-POINT (2026-09-03). This read
    // `.toBe("donruss-studio")`, and the census overturned it the same way it
    // overturned Select Certified: measured read-only against prod, the
    // checklists for 1991-2005 Studio live under `studio` (7,867 checklist
    // rows, baseballcardpedia) while `donruss-studio` holds ZERO checklist
    // rows against 1,191 derived/vendor ones. Count by source, not row count —
    // a destination no checklist has ever written cannot be the canonical
    // spelling of one that is checklist-backed. The pool agrees: the sales are
    // titled "1992 Studio Baseball", and "Donruss Studio" only from 2003.
    expect(resolveSetKeyForSlug("baseball", "1995 Studio", 1995)).toBe("studio");
  });
});

describe("a key needs both halves at mint", () => {
  const entry = (setKey: string, cardNumber = "1", authoritative = true) =>
    deriveCatalogEntry({
      sport: "baseball", year: 2025, setKey, cardNumber, parallel: "Base", isAuto: false, printRun: null,
      playerName: "Some Player", source: "checklist", confidence: 0.9, authoritativeSetKey: authoritative,
    })!;

  it("the setKey field is the id's own segment, not the caller's spelling", () => {
    expect(entry("leaf-metal-baseball").setKey).toBe("leaf-metal");
    expect(entry("leaf-metal-baseball").id).toContain(":leaf-metal:");
    expect(entry("Topps Update").setKey).toBe("topps-update-series");
    expect(entry("topps-series-1").setKey).toBe("topps-series-1");
    expect(entry("2025 Donruss Baseball").setKey).toBe("panini-donruss");
  });

  it("the vendor-text chrome repair moves both halves", () => {
    const e = entry("bowman", "BCP-1", false);
    expect(e.id).toContain(":bowman-chrome:");
    expect(e.setKey).toBe("bowman-chrome");
  });
});

describe("card-number spelling keeps the checklist's hyphen; every match is hyphen-insensitive (ruling d)", () => {
  it("the slug segment is the checklist's spelling", () => {
    expect(id("Bowman Draft", 2020, "BD-152")).toContain(":bd-152:");
    expect(id("Bowman Draft", 2020, "BD152")).toContain(":bd152:");
    expect(id("Topps Update", 2025, "US135")).toContain(":us135:");
  });

  it("bd152 ≡ BD-152 ≡ bd-152", () => {
    expect(sameCardNumber("BD152", "bd-152")).toBe(true);
    expect(sameCardNumber("bd-152", "BD-152")).toBe(true);
    expect(sameCardNumber("US135", "US-135")).toBe(true);
    expect(sameCardNumber("CPA-TG", "cpatg")).toBe(true);
    expect(sameCardNumber("BD-152", "BD-153")).toBe(false);
    expect(sameCardNumber("BD-152", "BDC-152")).toBe(false);
    expect(sameCardNumber("", "")).toBe(false);
    expect(sameCardNumber(null, undefined)).toBe(false);
    expect(foldCardNumber(" bd-152 ")).toBe("BD152");
  });

  it("the index-friendly variants carry both spellings", () => {
    expect(cardNumberVariants("BD152")).toEqual(expect.arrayContaining(["BD152", "bd152", "BD-152", "bd-152"]));
    expect(cardNumberVariants("bd-152")).toEqual(expect.arrayContaining(["bd-152", "BD-152", "BD152", "bd152"]));
    expect(cardNumberVariants("100")).toEqual(["100"]);
    expect(cardNumberVariants("")).toEqual([]);
    const c = cardNumberInClause("BD152", "@x");
    expect(c.sql).toBe(c.params.map((p) => p.name).join(", "));
    expect(c.params.map((p) => p.value)).toContain("BD-152");
    expect(new Set(c.params.map((p) => p.name)).size).toBe(c.params.length);
  });
});

describe("the family table feeds pricing and search without changing identity (ruling c)", () => {
  it("topps ⊃ topps-series-1 ⊃ …; bowman-draft ≠ 1st Edition; sapphire never crosses; Donruss is one line", () => {
    expect(productFamilyKey("topps-series-1")).toBe("topps");
    expect(productFamilyKey("topps-update-series")).toBe("topps");
    expect(productFamilyKey("topps-update")).toBe("topps");                  // the legacy spelling, while the fleet runs
    expect(productFamilyKey("topps-chrome-update-series")).toBe("topps-chrome");
    expect(sameProductFamily("topps-series-1", "topps")).toBe(true);
    expect(sameProductFamily("topps-update", "topps-update-series")).toBe(true);
    expect(sameProductFamily("bowman-draft-1st-edition", "bowman-draft")).toBe(false);
    expect(sameProductFamily("topps-chrome-update-sapphire", "topps-chrome-update-series")).toBe(false);
    expect(sameProductFamily("donruss", "panini-donruss")).toBe(true);
    expect(sameProductFamily("leaf-vivid", "leaf-metal")).toBe(false);
    expect(sameProductFamily("leaf-metal-draft", "leaf-metal")).toBe(true);
    expect(sameProductFamily("bowman", "bowman-chrome")).toBe(false);
    expect(sameProductFamily("topps", "topps-chrome")).toBe(false);
  });

  it("the cross-setkey rung crosses topps-series-1 ↔ topps and refuses 1st Edition ↔ Draft", () => {
    const target = { sport: "baseball", year: 2024, setKey: "topps-series-1", cardNumber: "100", isAuto: false, parallel: "base", printRun: null, playerFold: foldPlayerName("Bobby Witt Jr.") };
    const rows = [
      { hobbyiqCardId: "hiq:baseball:2024:topps:100:base:no-auto", playerName: "Bobby Witt Jr." },
      { hobbyiqCardId: "hiq:baseball:2024:topps-chrome:100:base:no-auto", playerName: "Bobby Witt Jr." },
    ];
    const v = filterCrossSetKeyComps(target, rows);
    expect(v.kept.map((r) => r.hobbyiqCardId)).toEqual(["hiq:baseball:2024:topps:100:base:no-auto"]);
    expect(v.excluded.otherFamily).toBe(1);

    const draft = { ...target, year: 2020, setKey: "bowman-draft-1st-edition", cardNumber: "BD-152" };
    const d = filterCrossSetKeyComps(draft, [
      { hobbyiqCardId: "hiq:baseball:2020:bowman-draft:bd-152:base:no-auto", playerName: "Bobby Witt Jr." },
      { hobbyiqCardId: "hiq:baseball:2020:bowman-draft-1st-edition:bd152:base:no-auto", playerName: "Bobby Witt Jr." },
    ]);
    expect(d.kept.map((r) => r.hobbyiqCardId)).toEqual(["hiq:baseball:2020:bowman-draft-1st-edition:bd152:base:no-auto"]);  // bd152 ≡ BD-152
    expect(d.excluded.otherFamily).toBe(1);
  });

  it("search narrows on the product words the id now carries", () => {
    const tok = (q: string) => q.toLowerCase().replace(/[^a-z0-9#-]+/g, " ").replace(/#/g, "").trim().split(/\s+/).filter(Boolean);
    const hits = [
      { slug: "s1", setKey: "topps-series-1", setName: "Topps Series 1" },
      { slug: "s2", setKey: "topps-series-2", setName: "Topps Series 2" },
      { slug: "tc", setKey: "topps-chrome", setName: "Topps Chrome" },
      { slug: "lm", setKey: "leaf-metal", setName: "Leaf Metal" },
      { slug: "lv", setKey: "leaf-vivid", setName: "Leaf Vivid" },
    ];
    expect(narrowToNamedProduct(tok("2024 topps series 1 #100"), hits).map((h) => h.slug).sort()).toEqual(["s1", "s2"]);
    expect(narrowToNamedProduct(tok("2025 leaf metal #1"), hits).map((h) => h.slug)).toEqual(["lm"]);
    expect(PRODUCT_WORDS.has("vivid")).toBe(true);
    expect(PRODUCT_WORDS.has("metal")).toBe(true);
  });

  it("the matcher widens a plain product into its verified refinements, every spelling, never into another set", () => {
    const w = widenedSetKeys("topps");
    expect(w).toEqual(expect.arrayContaining(["topps-series-1", "topps-series-2", "topps-update-series", "topps-update", "topps-updates-and-highlights"]));
    expect(w).not.toContain("topps-chrome");
    expect(w).not.toContain("topps-series-1-1st-edition");
    expect(widenedSetKeys("topps-chrome")).toEqual(expect.arrayContaining(["topps-chrome-update-series", "topps-chrome-update"]));
    expect(widenedSetKeys("bowman")).toEqual([]);
  });

  it("the parent walk reads the table too", () => {
    expect(deriveParentSetKey("topps-series-1")).toBe("topps");
    expect(deriveParentSetKey("topps-update")).toBe("topps");
    expect(deriveParentSetKey("topps-chrome-update-series")).toBe("topps-chrome");
    expect(deriveParentSetKey("bowman-draft-1st-edition")).toBe("bowman-draft");   // a lookup parent, not a pricing family
    expect(deriveParentSetKey("topps")).toBeNull();
  });

  it("a product qualifier in a title moves to the series keys; the Chrome Update refusal is lifted", () => {
    expect(qualifiedSetKeyFromTitle("Topps", "2024 Topps Update Series #US1 Paul Skenes RC").setKey).toBe("topps-update-series");
    expect(qualifiedSetKeyFromTitle("Topps Chrome", "2024 Topps Chrome Update Series #USC88 Paul Skenes"))
      .toMatchObject({ setKey: "topps-chrome-update-series", refused: [] });
  });
});
