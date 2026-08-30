// CF-A-VARIATION-IS-A-CARD (D22, Drew 2026-08-30). An image variation shares
// the base card's number and is a different card. One vocabulary
// (variationVocabulary.ts) behind the slug layer, the title parser, the
// ingest seam, the holding normalizer and the page converters; a weak title
// marker ("SP", "SSP", "IV", "Short Print") becomes a variation only when the
// product's own checklist holds one for that card. Fixture titles are real
// pool titles (read-only sample of 443,988 base-slug rows, 2026-08-30).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  canonicalVariationName,
  chromeRefractorSuffixForVariation,
  normalizeVariationSlug,
  pickVariationForMarker,
  readVariationFromTitle,
  reduceVariationStockToCatalog,
  variationFinishOfSection,
  variationNameFromSlug,
} from "../src/services/catalog/variationVocabulary.js";
import { computeHobbyIqCardId, normalizeParallel, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { parseListingTitle } from "../src/services/portfolioiq/ebayTitleParser.service.js";
import { parallelTheTitleAllows } from "../src/services/portfolioiq/titleOutranksVendorTag.js";
import { normalizeHoldingFields } from "../src/services/portfolioiq/holdingFieldNormalizer.service.js";
import { exactIdentityCandidates } from "../src/services/portfolioiq/exactPoolSupremacy.js";
import { qualifiedSetKeyFromTitle } from "../src/services/catalog/productQualifiers.js";

const slug = (setKey: string, parallel: string, cardNumber = "1", isAuto = false) =>
  computeHobbyIqCardId({ sport: "baseball", year: 2024, setKey, cardNumber, parallel, isAuto, printRun: null } as never);
const parallelOf = (s: string) => s.split(":")[5];

describe("the vocabulary: one spelling per card", () => {
  it("normalizeVariationSlug — every spelling the catalog holds today lands on one form", () => {
    const table: Array<[string, string]> = [
      ["image-variation", "image-variation"], ["image-variations", "image-variation"], ["variation", "image-variation"], ["variations", "image-variation"],
      ["photo-variation", "image-variation"], ["photo-variations", "image-variation"], ["picture-variation", "image-variation"], ["var", "image-variation"],
      ["iv", "image-variation"], ["image-var", "image-variation"], ["sp-variation", "image-variation"], ["variation-sp", "image-variation"],
      ["image-variation-sp", "image-variation"], ["base-image-variation", "image-variation"], ["base-variation-set", "image-variation"],
      ["ssp", "image-variation-ssp"], ["super-short-print", "image-variation-ssp"], ["super-short-prints", "image-variation-ssp"],
      ["ssp-variation", "image-variation-ssp"], ["variation-ssp", "image-variation-ssp"], ["super-short-print-variation", "image-variation-ssp"],
      ["golden-mirror-image-variations", "golden-mirror-variation"], ["golden-mirror-image-variation", "golden-mirror-variation"],
      ["golden-mirror-variations", "golden-mirror-variation"], ["base-golden-mirror-variation", "golden-mirror-variation"],
      ["golden-mirror-image-variation-short-print", "golden-mirror-variation"],
      ["lightboard-logo-base-variation", "lightboard-logo-variation"], ["lightboard-logo-variation", "lightboard-logo-variation"],
      ["clear-variations", "clear-variation"], ["true-photo-variations", "true-photo-variation"], ["team-color-border-variations", "team-color-border-variation"],
      ["murakami-variations", "murakami-variation"], ["murakami-variation-refractor", "murakami-variation-refractor"],
      ["image-variations-gold-speckle", "image-variation-gold-speckle"], ["image-variation-gold-speckle-refractor", "image-variation-gold-speckle-refractor"],
      ["chrome-variation", "chrome-variation"], ["chrome-variations-superfractor", "chrome-variation-superfractor"],
      ["rookie-image-variations", "rookie-image-variation"], ["chrome-image-variation", "chrome-image-variation"],
      ["sp-chrome", "image-variation-chrome"], ["ssp-chrome", "image-variation-ssp-chrome"], ["sp-paper", "image-variation-paper"],
      ["black-&-white-image-variation", "black-&-white-variation"], ["action-variation", "action-variation"], ["throwback-uniform-variations", "throwback-uniform-variation"],
      ["sp", "sp"], ["short-print", "short-print"], ["short-prints", "short-print"],
      ["gold-refractor", "gold-refractor"], ["base", "base"], ["", ""],
    ];
    for (const [input, want] of table) expect(normalizeVariationSlug(input), input).toBe(want);
  });

  it("canonicalVariationName — text to the display name; a bare SP is not a variation", () => {
    expect(canonicalVariationName("Photo Variations")).toBe("Image Variation");
    expect(canonicalVariationName("IMAGE VARIATION")).toBe("Image Variation");
    expect(canonicalVariationName("Image Var")).toBe("Image Variation");
    expect(canonicalVariationName("SSP")).toBe("Image Variation SSP");
    expect(canonicalVariationName("Ssp")).toBe("Image Variation SSP");
    expect(canonicalVariationName("SP Variation")).toBe("Image Variation");
    expect(canonicalVariationName("Golden Mirror Image Variations")).toBe("Golden Mirror Variation");
    expect(canonicalVariationName("Chrome Variation")).toBe("Chrome Variation");
    expect(canonicalVariationName("Black & White Image Variation")).toBe("Black & White Variation");
    expect(canonicalVariationName("Image Variation Gold Speckle Refractor")).toBe("Image Variation Gold Speckle Refractor");
    expect(canonicalVariationName("SP")).toBeNull();
    expect(canonicalVariationName("Short Print")).toBeNull();
    expect(canonicalVariationName("Gold Refractor")).toBeNull();
    expect(variationNameFromSlug("image-variation-ssp")).toBe("Image Variation SSP");
    expect(variationNameFromSlug("gold")).toBeNull();
  });

  it("variationFinishOfSection — every page shape found on 29 real checklistcenter pages", () => {
    expect(variationFinishOfSection("Image Variations")).toBe("Image Variation");
    expect(variationFinishOfSection("Image Variation")).toBe("Image Variation");
    expect(variationFinishOfSection("Image Variations SuperFractor")).toBe("Image Variation SuperFractor");
    expect(variationFinishOfSection("Image Variations Gold Speckle")).toBe("Image Variation Gold Speckle");
    expect(variationFinishOfSection("Base Image Variation Set")).toBe("Image Variation");
    expect(variationFinishOfSection("2020 Bowman Draft - Base Image Variation Set")).toBe("Image Variation");
    expect(variationFinishOfSection("2021 Bowman Draft - Base Image Variations Auto Set")).toBe("Image Variation Auto");
    expect(variationFinishOfSection("Base Golden Mirror Image Variation")).toBe("Golden Mirror Variation");
    expect(variationFinishOfSection("Golden Mirror Image Variations")).toBe("Golden Mirror Variation");
    expect(variationFinishOfSection("Base True Photo Variations")).toBe("True Photo Variation");
    expect(variationFinishOfSection("Base SP Variation Set")).toBe("Image Variation");
    expect(variationFinishOfSection("Base Super Short Print Variation")).toBe("Image Variation SSP");
    expect(variationFinishOfSection("Super Short Prints")).toBe("Image Variation SSP");
    expect(variationFinishOfSection("Variations", "Etched in Glass")).toBe("Image Variation");
    expect(variationFinishOfSection("Etched in Glass Variations", "Etched in Glass")).toBe("Image Variation");
    expect(variationFinishOfSection("Chrome Prospects Prospector's Special Die-Cut Variation", "Chrome Prospects")).toBe("Prospector's Special Die-Cut Variation");
    expect(variationFinishOfSection("Rookie Image Variations")).toBe("Rookie Image Variation");
    expect(variationFinishOfSection("Chrome College Variations")).toBe("Chrome College Variation");
    expect(variationFinishOfSection("WBC Flag Variation")).toBe("WBC Flag Variation");
    expect(variationFinishOfSection("Base WBC Flag Variation Green Refractor")).toBe("WBC Flag Variation Green Refractor");
    expect(variationFinishOfSection("Short Prints")).toBeNull();
    expect(variationFinishOfSection("Extended Base SP")).toBeNull();
    expect(variationFinishOfSection("Gold Refractor")).toBeNull();
    expect(variationFinishOfSection("Base")).toBeNull();
  });

  it("pickVariationForMarker — a weak marker is corroborated only by the card's PLAIN image variation", () => {
    expect(pickVariationForMarker("ssp", ["base", "image-variation", "image-variation-ssp"])).toBe("image-variation-ssp");
    expect(pickVariationForMarker("ssp", ["base", "image-variations"])).toBe("image-variation");
    expect(pickVariationForMarker("sp", ["base", "image-variation"])).toBe("image-variation");
    expect(pickVariationForMarker("iv", ["base", "image-variation", "lightboard-logo-variation"])).toBe("image-variation");
    expect(pickVariationForMarker("short-print", ["base", "image-variation"])).toBe("image-variation");
    // Heritage: a bare SP is the short-printed base, never its Action Variation.
    expect(pickVariationForMarker("sp", ["base", "action-variation"])).toBeNull();
    expect(pickVariationForMarker("sp", ["base", "short-print"])).toBeNull();
    // A grader label's stock word is the card's only where the checklist distinguishes it.
    expect(reduceVariationStockToCatalog("Image Variation Chrome", ["base", "image-variation"])).toBe("Image Variation");
    expect(reduceVariationStockToCatalog("Image Variation Chrome", ["base", "image-variation-chrome", "image-variation-paper"])).toBe("Image Variation Chrome");
    expect(reduceVariationStockToCatalog("Image Variation Chrome", ["base"])).toBe("Image Variation Chrome");
    expect(reduceVariationStockToCatalog("Gold Refractor", ["base"])).toBeNull();
    expect(pickVariationForMarker("ssp", ["base", "gold-refractor"])).toBeNull();
    expect(pickVariationForMarker(null, ["image-variation"])).toBeNull();
  });
});

describe("the slug layer: the variation is its own card, with the base card's number", () => {
  it("normalizeParallel speaks the vocabulary; 'True Photo' is a kind, not True Blue", () => {
    expect(normalizeParallel("Image Variations")).toBe("image-variation");
    expect(normalizeParallel("Photo Variation")).toBe("image-variation");
    expect(normalizeParallel("SSP")).toBe("image-variation-ssp");
    expect(normalizeParallel("True Photo Variations")).toBe("true-photo-variation");
    expect(normalizeParallel("True Blue")).toBe("blue-refractor");
    expect(normalizeParallel("Golden Mirror Image Variation SP")).toBe("golden-mirror-variation");
  });

  it("on chrome stock a bare variation is not a refractor; a colour named after it is", () => {
    expect(chromeRefractorSuffixForVariation("image-variation")).toBe("image-variation");
    expect(chromeRefractorSuffixForVariation("image-variation-ssp")).toBe("image-variation-ssp");
    expect(chromeRefractorSuffixForVariation("image-variation-gold-speckle")).toBe("image-variation-gold-speckle-refractor");
    expect(chromeRefractorSuffixForVariation("image-variation-superfractor")).toBe("image-variation-superfractor");
    expect(chromeRefractorSuffixForVariation("image-variation-chrome")).toBe("image-variation-chrome");
    expect(chromeRefractorSuffixForVariation("gold")).toBeNull();
    expect(parallelOf(slug("Topps Chrome", "Image Variations"))).toBe("image-variation");
    expect(parallelOf(slug("Topps Chrome", "Image Variation Gold Speckle"))).toBe("image-variation-gold-speckle-refractor");
    expect(parallelOf(slug("Topps Chrome", "Gold"))).toBe("gold-refractor");
    expect(parallelOf(slug("Topps", "SSP"))).toBe("image-variation-ssp");
    expect(parallelOf(slug("Topps Update", "Golden Mirror Image Variations"))).toBe("golden-mirror-variation");
    expect(parallelOf(slug("Topps Heritage", "Chrome Variation"))).toBe("chrome-variation");
  });

  it("identity: same number, different parallel segment — never a twin of the base, never folded into it", () => {
    const base = "hiq:baseball:2020:bowman-draft:bd152:base:no-auto";
    const iv = "hiq:baseball:2020:bowman-draft:bd152:image-variation:no-auto";
    expect(iv.split(":")[4]).toBe(base.split(":")[4]);
    expect(exactIdentityCandidates({ hobbyiqCardId: iv, cardId: null, printRun: null })).toEqual([iv]);
    expect(exactIdentityCandidates({ hobbyiqCardId: base, cardId: null, printRun: null })).not.toContain(iv);
    // The twin rule everywhere is the :num-N segment alone — the fold's own regex.
    const fold = fs.readFileSync(path.join(__dirname, "..", "scripts", "fold-unnumbered-twins.cjs"), "utf8");
    expect(fold).toMatch(/const NUM_SEG = \/:num-\\d\+\(\?::\|\$\)\//);
    expect(/:num-\d+(?::|$)/.test(iv)).toBe(false);
    // The Colour ≡ Refractor fold touches bare colours only.
    const merge = fs.readFileSync(path.join(__dirname, "..", "scripts", "merge-bare-colour-parallels.cjs"), "utf8");
    expect(merge).toMatch(/if \(!BARE_COLOURS\.has\(parallel\)\) continue;/);
  });

  it("1st Edition is another set: the grammar keeps it", () => {
    expect(normalizeSetKey("2020 Bowman Draft 1st Edition Baseball")).toBe("bowman-draft-1st-edition");
    expect(normalizeSetKey("Bowman Draft First Edition")).toBe("bowman-draft-1st-edition");
    expect(normalizeSetKey("2021 Bowman 1st Edition")).toBe("bowman-1st-edition");
    expect(normalizeSetKey("2020 Bowman Draft")).toBe("bowman-draft");
    expect(computeHobbyIqCardId({ sport: "baseball", year: 2020, setKey: "Bowman Draft 1st Edition", cardNumber: "BD-152", parallel: "Base", isAuto: false, printRun: null } as never))
      .toBe("hiq:baseball:2020:bowman-draft-1st-edition:bd-152:base:no-auto");
  });
});

describe("the title parser: every abbreviation sellers use (real pool titles)", () => {
  const strong: Array<[string, string, string | null]> = [
    ["2024 Topps Chrome Update #USC88 Paul Skenes Image Var SGC 9", "Image Variation", null],
    ["2024 Topps Chrome #122 Wyatt Langford Photo Variations RC Rangers - Raw 10", "Image Variation", "Wyatt Langford"],
    ["2024 TOPPS CHROME VAR #207 JACKSON MERRILL ROOKIE RC PSA 10", "Image Variation", null],
    ["2024 TOPPS CHROME SHOHEI OHTANI VARIATION SP PSA 10 🔥 DODGERS 🌟", "Image Variation", null],
    ["2024 Topps Chrome Aaron Judge Ultraviolet Sp Variation Case Hit New York Yankees - Raw 10", "Image Variation", null],
    ["2024 Topps Update Paul Skenes IV #US1 Pirates RC", "Image Variation", null],
    ["2023 Topps Series 1 Julio Rodriguez SSP Variation #100", "Image Variation SSP", null],
    ["2024 Topps Series 2 Elly De La Cruz Super Short Print Variation #200", "Image Variation SSP", null],
    ["2024 Topps Chrome Shohei Ohtani Image Variation Gold Speckle Refractor /50 #1", "Image Variation Gold Speckle Refractor", null],
    ["2024 Topps Heritage Elly De La Cruz Action Variation #200", "Action Variation", null],
    ["2024 Topps Update Elly De La Cruz Golden Mirror SP #US50", "Golden Mirror Variation", null],
    ["2024 Topps Update Series Golden Mirror Image Variation Bobby Witt Jr #US100", "Golden Mirror Variation", "Bobby Witt Jr."],
    ["2020 Bowman Draft Bobby Witt Jr #BD152 SP-Chrome PSA 9 MINT", "Image Variation Chrome", null],
    ["2020 BOWMAN DRAFT #BD152 BOBBY WITT JR. SP-CHROME MINT 9", "Image Variation Chrome", null],
    ["2023 Topps Series 1 Corbin Carroll #150 SSP-Chrome PSA 10", "Image Variation SSP Chrome", null],
    ["2021 Bowman Draft Marcelo Mayer BD-1 SP Paper PSA 10", "Image Variation Paper", null],
    ["2023 Topps Heritage Aaron Judge Black and White Variation #100", "Black & White Variation", null],
    ["2023 Topps Heritage Julio Rodriguez Throwback Uniform Variation #250", "Throwback Uniform Variation", null],
    ["2024 Topps Chrome Sal Frelick 39 RC Logofractor Variation SP | Milwaukee Brewers - Raw 10", "Image Variation Logofractor", null],
  ];
  for (const [title, want, player] of strong) {
    it(`"${title.slice(0, 60)}" → ${want}`, () => {
      const p = parseListingTitle(title);
      expect(p.parallel).toBe(want);
      expect(p.variationMarker ?? null).toBeNull();
      if (player) expect(p.playerName).toBe(player);
    });
  }

  it("weak markers are reported, never guessed: bare SP / SSP / Short Print / IV out of context", () => {
    expect(parseListingTitle("2024 Topps Chrome - PSA 10 Shohei Ohtani SSP US#1")).toMatchObject({ parallel: null, variationMarker: "ssp" });
    expect(parseListingTitle("2024 Topps Chrome Shohei Ohtani #1 SP SGC 10")).toMatchObject({ parallel: null, variationMarker: "sp" });
    expect(parseListingTitle("2024 Topps Chrome ELLY DE LA CRUZ (RC) All-Etch Rookie Rush Short Print CERR-1 - Raw 10")).toMatchObject({ parallel: null, variationMarker: "short-print" });
    expect(parseListingTitle("2024 Topps Chrome Update Series MLB Paul Skenes RC IV Pittsburgh Pirates #USC88 - Raw 10")).toMatchObject({ parallel: null, variationMarker: "iv" });
    expect(parseListingTitle("2024-25 SP Authentic Future Watch Auto Patch #111 Gavin Brindley /100 Jackets").variationMarker).toBe("sp");
  });

  it("'Iván' is not 'IV', and a Roman-numeral name is not a variation", () => {
    expect(parseListingTitle("2023 Topps Chrome #177 Iván Herrera St. Louis Cardinals RC Baseball")).toMatchObject({ parallel: null, variationMarker: null });
    expect(parseListingTitle("2023 Topps Chrome Iván Herrera Rookie RC St. Louis Cardinals #177").variationMarker ?? null).toBeNull();
    expect(parseListingTitle("2020 Bowman Draft Bobby Witt Jr #BD-152 Gold Refractor /50").parallel).toBe("Gold Refractor");
    const iv = readVariationFromTitle("2024 topps ken griffey iv rookie card #12");
    expect(iv.finish).toBeNull();
    expect(iv.marker).toBe("iv");
  });
});

describe("the seam: the title outranks the vendor tag, and a marker corroborates a variation tag", () => {
  it("a title that names the variation wins over a Base tag; a silent title with no marker stays Base", () => {
    expect(parallelTheTitleAllows("Image Variation", "Base")).toEqual({ parallel: "Image Variation", vendorTagOverruled: null });
    expect(parallelTheTitleAllows("Image Variation", "Gold")).toEqual({ parallel: "Image Variation", vendorTagOverruled: "Gold" });
    expect(parallelTheTitleAllows(null, "Image Variation")).toEqual({ parallel: null, vendorTagOverruled: "Image Variation" });
  });
  it("a weak marker corroborates the vendor's variation tag, never a colour tag", () => {
    expect(parallelTheTitleAllows(null, "Image Variation", { variationMarker: "sp" })).toMatchObject({ parallel: "Image Variation", variationCorroboratedByMarker: true });
    expect(parallelTheTitleAllows(null, "SSP", { variationMarker: "ssp" })).toMatchObject({ parallel: "Image Variation SSP" });
    expect(parallelTheTitleAllows(null, "Gold", { variationMarker: "sp" })).toEqual({ parallel: null, vendorTagOverruled: "Gold" });
  });
  it("two spellings of one variation agree on the canonical one", () => {
    expect(parallelTheTitleAllows("Image Variations", "Image Variation")).toEqual({ parallel: "Image Variation", vendorTagOverruled: null });
    expect(parallelTheTitleAllows("Golden Mirror Variation", "Golden Mirror Image Variations")).toEqual({ parallel: "Golden Mirror Variation", vendorTagOverruled: null });
  });
});

describe("holdings: the identity derivation carries the variation into `parallel`", () => {
  it("the normalizer speaks the vocabulary and keeps a kind's own words", () => {
    expect(normalizeHoldingFields({ parallel: "Photo Variations" }).fields.parallel).toBe("Image Variation");
    expect(normalizeHoldingFields({ parallel: "SSP" }).fields.parallel).toBe("Image Variation SSP");
    expect(normalizeHoldingFields({ parallel: "Chrome Variation" }).fields.parallel).toBe("Chrome Variation");
    expect(normalizeHoldingFields({ parallel: "Chrome-Image Variation" }).fields.parallel).toBe("Chrome Image Variation");
    expect(normalizeHoldingFields({ parallel: "SP-CHROME" }).fields.parallel).toBe("Image Variation Chrome");
    expect(normalizeHoldingFields({ parallel: "Chrome Refractor" }).fields.parallel).toBe("Refractor");
    expect(normalizeHoldingFields({ parallel: "SP" }).fields.parallel).toBe("SP");
    const twice = normalizeHoldingFields(normalizeHoldingFields({ parallel: "Golden Mirror Image Variations" }).fields);
    expect(twice.fields.parallel).toBe("Golden Mirror Variation");
    expect(twice.changes).toEqual([]);
  });
});

describe("product qualifiers in titles are identity", () => {
  it("the Witt 1st Edition sale asks for bowman-draft-1st-edition", () => {
    const q = qualifiedSetKeyFromTitle("2020 Bowman Draft Baseball", "2020 Bowman Draft 1st Edition - Bobby Witt Jr #BD-152 (RC) - Raw 10");
    expect(q).toMatchObject({ from: "bowman-draft", setKey: "bowman-draft-1st-edition", applied: ["1st Edition"], refused: [] });
  });
  it("Sapphire, Update and Chrome move the plain product; iterated", () => {
    expect(qualifiedSetKeyFromTitle("Bowman Draft", "2024 Bowman Draft Sapphire Konnor Griffin #BDC-1").setKey).toBe("bowman-draft-sapphire");
    expect(qualifiedSetKeyFromTitle("Topps", "2024 Topps Update Series #US1 Paul Skenes RC").setKey).toBe("topps-update");
    expect(qualifiedSetKeyFromTitle("Topps", "2020 Topps Chrome Bobby Witt Jr #100 RC").setKey).toBe("topps-chrome");
    expect(qualifiedSetKeyFromTitle("Topps", "2024 Topps Chrome Sapphire Edition #1 Ohtani")).toMatchObject({ setKey: "topps-chrome-sapphire", applied: ["Chrome", "Sapphire"] });
  });
  it("refusals are rulings, not bot moves; an already-qualified key and a Draft chrome card are not moves", () => {
    expect(qualifiedSetKeyFromTitle("Bowman", "2025 Bowman Chrome Prospects BCP-125 Owen Carey")).toMatchObject({ setKey: "bowman", applied: [], refused: [{ qualifier: "Chrome" }] });
    expect(qualifiedSetKeyFromTitle("Topps Chrome", "2024 Topps Chrome Update Series #USC88 Paul Skenes")).toMatchObject({ setKey: "topps-chrome", refused: [{ qualifier: "Update" }] });
    expect(qualifiedSetKeyFromTitle("Bowman Draft 1st Edition", "2020 Bowman Draft 1st Edition Bobby Witt Jr")).toMatchObject({ setKey: "bowman-draft-1st-edition", applied: [] });
    expect(qualifiedSetKeyFromTitle("Bowman Draft", "2025 Bowman Draft Chrome Max Williams CPA-MWI Refractor Auto /499")).toMatchObject({ setKey: "bowman-draft", applied: [], refused: [] });
    expect(qualifiedSetKeyFromTitle("Topps Heritage", "2024 Topps Heritage Chrome #100").setKey).toBe("topps-heritage");
  });
});
