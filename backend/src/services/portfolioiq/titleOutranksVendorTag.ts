// CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG (Drew, 2026-08-29: "Bases are tagged
// to this gold or the gold is tagged to bases"). persistVendorSalesToPool
// used to let the vendor's PRODUCT tag (identity.parallel -- CardHedge's
// variant, TCA's structured hint) overwrite the parallel the title parser
// read. Under one Gold Refractor /50 slug that left 38 base autos at $5-12
// whose titles never said gold; pool-wide, exact: CH Gold 226 / Blue 161 /
// Blue Refractor 467 / Black 132 / Silver 551, TCA colour refractors 1-3%.
//
// The rule, as a pure function so it is tested and single-spelled: the
// sale's parallel is what its TITLE says. A vendor tag can never add a
// finish the title does not name, and never replace one it does. The tag is
// returned as telemetry so the caller can count the disagreements.

import { canonicalVariationName, type VariationMarker } from "../catalog/variationVocabulary.js";

export interface ParallelDecision {
  parallel: string | null;
  /** The vendor tag that was NOT adopted, when it disagreed with the title. */
  vendorTagOverruled: string | null;
  /** D22: the vendor's variation tag was adopted because the title carried
   *  a weak marker ("SP", "SSP", "IV", "Short Print") that corroborates it. */
  variationCorroboratedByMarker?: boolean;
}

const norm = (v: string | null | undefined): string | null => {
  const s = String(v ?? "").trim();
  return s && !/^base$/i.test(s) ? s : null;
};

/** Bare colours the pool spells as "<Colour> Refractor" (the Colour ≡
 *  Refractor ruling): a vendor tag "Blue" against a title saying "Refractor"
 *  is a refinement, not a disagreement. */
const BARE_COLOURS = new Set(["gold", "blue", "green", "orange", "red", "purple", "black", "silver", "pink", "yellow", "aqua", "sapphire"]);

/** CF-A-REFINEMENT-IS-NOT-A-CONTRADICTION (2026-08-29, repair dry run #1).
 *  The eBay title parser names ONE token and lists "refractor" before the
 *  colours, so "Gold Refractor 1st #/50" parses as bare "Refractor". A vendor
 *  tag "Gold Refractor" against that title REFINES what the title says --
 *  adopting it is right; a title that names no finish at all, or a different
 *  one, still overrules the tag. */
/** CF-A-COLOUR-IS-NOT-A-FINISH-FAMILY (Drew, 2026-09-03: "Green refractors and
 *  bases are mixed in ... Bases are mixed in with refractors in ALL of
 *  Bowman"). The suffix rule above ("gold refractor" ends with "refractor")
 *  reads in BOTH directions if it is not bounded, and the unbounded direction
 *  is the one that merges pools: a title saying bare "Green" would adopt a
 *  vendor tag of "Green Wave", "Green Shimmer" or "Green Mojo Refractor",
 *  because each of those ends with " green"'s counterpart word. Measured on
 *  the live pool 2026-09-03: 122 Bowman slugs carry rows whose titles name
 *  green, green-refractor and green-wave at once.
 *
 *  Green, Green Refractor, Green Shimmer and Green Wave are FOUR cards with
 *  four checklist rows and four price curves. Only ONE promotion of a bare
 *  colour is a ruled refinement -- "{Colour}" to "{Colour} Refractor", the
 *  Colour-IS-Refractor ruling already encoded in BARE_COLOURS below. Every
 *  other finish family the vendor names is a DIFFERENT card, and the tag is
 *  overruled exactly as an unrelated colour already is.
 *
 *  So: when the title is nothing but a bare colour, the tag may only add the
 *  word "refractor". This narrows the suffix rule alone; a title that already
 *  names a finish ("Refractor" -> "Blue"/"Gold Refractor") is untouched, and
 *  so is the fuller-spelling subset rule, both of which stay pinned. */
function vendorAddsADifferentFinishFamily(vendor: string, title: string): boolean {
  if (!BARE_COLOURS.has(title)) return false;
  // The words the tag adds on top of the bare colour the title states.
  const added = vendor.split(/[^a-z0-9]+/).filter((w) => w && w !== title);
  if (added.length === 0) return false;
  return !added.every((w) => w === "refractor");
}

function refines(vendor: string, title: string): boolean {
  const v = vendor.toLowerCase(), t = title.toLowerCase();
  // A bare colour is promoted only to its OWN refractor, never into another
  // finish family -- checked before the suffix rule, which would allow both.
  if (vendorAddsADifferentFinishFamily(v, t)) return false;
  if (v.endsWith(" " + t)) return true;               // "gold refractor" refines "refractor"
  if (t === "refractor" && BARE_COLOURS.has(v)) return true; // "blue" IS "blue refractor"
  if (vendorSpellsTheSameFinish(v, t)) return true;
  return false;
}

/** CF-THE-FULLER-SPELLING-IS-THE-SAME-FINISH (Drew, 2026-08-31). The title
 *  parser drops "&" and trailing nouns, so the real Red Ink title "…Black &
 *  White Red Ink #CPA-VF" parses as "Black White Red" -- every word of which
 *  the vendor tag "Black & White Red Ink" already contains. That is one finish
 *  spelled two ways, not two finishes, and treating it as a disagreement would
 *  file genuine Red Ink sales under a "Black White Red" row of their own --
 *  a split pool, the very thing the title rule exists to prevent.
 *
 *  So: when the title's words are a SUBSET of the vendor tag's words, the tag
 *  is adopted as the canonical spelling. This can only ever ADD words the
 *  title already agreed with; a title naming a word the tag lacks ("Blue"
 *  against "Black & White Red Ink") is still a real disagreement and still
 *  overrules. The title must name at least one finish word -- a silent title
 *  has an empty word set and must never subset its way into a finish. */
function vendorSpellsTheSameFinish(vendor: string, title: string): boolean {
  const words = (s: string): string[] => s.split(/[^a-z0-9]+/).filter(Boolean);
  const titleWords = words(title);
  if (titleWords.length === 0) return false;
  const vendorWords = new Set(words(vendor));
  return titleWords.every((w) => vendorWords.has(w));
}

export function parallelTheTitleAllows(
  titleParallel: string | null | undefined,
  vendorParallel: string | null | undefined,
  opts: { variationMarker?: VariationMarker | null } = {},
): ParallelDecision {
  const fromTitle = norm(titleParallel);
  const fromVendor = norm(vendorParallel);
  if (fromVendor === null) return { parallel: fromTitle, vendorTagOverruled: null };
  // CF-A-VARIATION-IS-A-CARD (D22). A vendor tag that names a variation
  // ("Image Variation", "SSP") is adopted when the title, though it never
  // spelled the variation, carries a weak marker for one: "SP", "SSP", "IV",
  // "Short Print". The marker corroborates the tag; a colour tag it cannot.
  const vendorVariation = canonicalVariationName(fromVendor);
  if (fromTitle === null) {
    if (opts.variationMarker && vendorVariation) return { parallel: vendorVariation, vendorTagOverruled: null, variationCorroboratedByMarker: true };
    return { parallel: null, vendorTagOverruled: fromVendor };
  }
  if (fromTitle.toLowerCase() === fromVendor.toLowerCase()) return { parallel: fromTitle, vendorTagOverruled: null };
  // Two spellings of one variation ("Image Variations" / "Image Variation")
  // agree; the canonical spelling is adopted.
  const titleVariation = canonicalVariationName(fromTitle);
  if (titleVariation && vendorVariation && titleVariation === vendorVariation) return { parallel: titleVariation, vendorTagOverruled: null };
  if (refines(fromVendor, fromTitle)) return { parallel: fromVendor, vendorTagOverruled: null };
  return { parallel: fromTitle, vendorTagOverruled: fromVendor };
}
