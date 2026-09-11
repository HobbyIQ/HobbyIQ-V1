/**
 * CF-A-VARIATION-IS-A-CARD (D22, Drew 2026-08-30: "image variations are
 * typical in card sets, so we need to fix that"; "it will have the same card
 * number but be called IV, Image Variation or other uses in sold comp data";
 * the PSA label on holding 3fe98abe reads "2020 BOWMAN DRAFT #BD152 BOBBY
 * WITT JR. SP-CHROME MINT 9").
 *
 * ONE spelling of the image-variation family, for every seam that meets it:
 * the slug layer (normalizeParallel), the listing-title parsers, the ingest
 * seam, the holding normalizer, the cert lookup, the checklist converters and
 * the pool repair.
 *
 * What a variation IS. A photo / image variation is a distinct card that
 * shares the base card's number: same #, a different photo (or a stamped,
 * foiled, colour-swapped or otherwise altered image), short-printed. Topps
 * flagship tiers them SP and SSP; Topps Chrome names them "Image Variation";
 * Bowman / Bowman Draft "Image Variations"; Heritage names each kind ("Action
 * Variation", "Throwback Uniform Variation", "Nickname Variation", "Color
 * Swap Variation", "Chrome Variation"); Topps 2024–25 names kinds ("Golden
 * Mirror", "True Photo", "Clear", "Team Color", "Lightboard Logo",
 * "Murakami", "FrozenFractor"). Sellers write "IV", "Image Var", "Photo Var",
 * "Var", "Variation", "SP Variation", "SSP", "SP", "Short Print"; grader
 * labels write "SP-CHROME", "SSP-CHROME", "SP-PAPER".
 *
 * Measured 2026-08-30 (read-only, card_catalog): 1,066 distinct parallel
 * spellings carry a variation word — "Clear Variation" 4,888 beside "Clear
 * Variations" 700; "Ssp" 2,792 beside "SSP" 2,587; "Image Variations" 1,886
 * beside "Image Variation" 1,460 and "IMAGE VARIATION" 350; "Golden Mirror
 * Image Variations" / "Golden Mirror Image Variation" / "Golden Mirror
 * Variations" / "Golden Mirror Variation" / "Base Golden Mirror Variation"
 * 1,034 / 760 / 1,129 / 391 / 350; "Lightboard Logo Base Variation" 1,744
 * beside "Lightboard Logo Variation" 1,724. One card, six slugs. In the pool
 * (443,988 rows under BASE slugs of 15 products with variation sections),
 * 8,937 titles (2.0%) carry a variation token: bare "SP" 5,194 (much of it
 * "SP Authentic" and short-printed INSERTS), "SSP" 1,780, bare "Variation"
 * 1,011, "Short Print" 775, "Image/Photo Var(iation)" 75, "IV" 77 (74 of them
 * "Iván" — the token needs a Unicode boundary), "Var" 25.
 *
 * THE VOCABULARY (slug forms; the display name is the Title Case of it):
 *
 *   image-variation        the plain photo / image variation — "Image
 *                          Variation(s)", "Photo Variation(s)", "Picture
 *                          Variation", bare "Variation(s)", "Var", "IV",
 *                          "SP Variation" / "Variation SP" (SP is the DEFAULT
 *                          tier and is not spelled in the slug), and the
 *                          accepted alias `image-variation-sp`.
 *   image-variation-ssp    the super-short-print tier — "SSP Variation",
 *                          "Super Short Print(s)", bare "SSP".
 *   image-variation-chrome / -paper / -ssp-chrome
 *                          the stock a grader label names ("SP-CHROME",
 *                          "SSP-CHROME", "SP-PAPER") — kept only where the
 *                          product's checklist distinguishes the two (see
 *                          reduceVariationStockToCatalog).
 *   <kind>-variation       a named kind keeps the page's words, singular,
 *                          without base / set / cards and without the SP
 *                          tier word; image / photo come off only when what
 *                          remains is a KNOWN kind ("Golden Mirror Image
 *                          Variation" → golden-mirror-variation) — "True
 *                          Photo" keeps its photo and an unknown "Rookie
 *                          Image Variation" keeps every word it has:
 *                          golden-mirror-variation, true-photo-variation,
 *                          clear-variation, team-color-variation,
 *                          team-color-border-variation,
 *                          lightboard-logo-variation, murakami-variation,
 *                          frozenfractor-variation, action-variation,
 *                          throwback-uniform-variation, nickname-variation,
 *                          color-swap-variation, chrome-variation,
 *                          black-&-white-variation, rookie-design-variation,
 *                          1991-design-variation, wbc-flag-variation,
 *                          retrofractor-variation, award-winners-variation …
 *                          A finish AFTER the word keeps its place:
 *                          image-variation-gold-speckle-refractor,
 *                          murakami-variation-refractor.
 *   sp / short-print       a bare "SP" / "Short Print(s)" that names NO
 *                          variation is NOT one: in Heritage / Allen & Ginter
 *                          a short print is the scarce BASE card. The spelling
 *                          the catalog holds is kept (`sp`; `short-print`
 *                          singular) and only the product's own checklist can
 *                          make a bare marker a variation (pickVariationForMarker).
 *
 * Identity: the variation row sits beside the base row under the SAME
 * cardNumber; only the parallel segment differs. It is never a twin of the
 * base (twins differ only by `:num-N`) and never folds into it.
 */

export type VariationTier = "sp" | "ssp";
export type VariationStock = "chrome" | "paper";

/** Weak markers: tokens that name a variation only with context — the
 *  product's checklist must corroborate them (pickVariationForMarker). */
export type VariationMarker = "iv" | "sp" | "ssp" | "short-print";

export interface VariationRead {
  /** The composed display name ("Image Variation", "Image Variation SSP",
   *  "Golden Mirror Variation", "Image Variation Chrome"), or null when the
   *  text names no variation. */
  finish: string | null;
  /** The named kind's words, lower-case, or null for the plain image variation. */
  kind: string | null;
  tier: VariationTier | null;
  /** The stock a grader-label form named ("SP-CHROME"), else null. */
  stock: VariationStock | null;
  /** A weak marker seen without a variation word; null when none or when
   *  the finish is already named. */
  marker: VariationMarker | null;
  /** The exact title substrings the read consumed, so a caller can blank
   *  them before its own scan (a "Black & White Variation" must not also
   *  read as the colours Black and White). */
  consumed: string[];
  /** The words of those substrings (for the player-name extractor). */
  words: string[];
}

/** Words that never carry identity inside a variation name. */
const NEVER_KIND = new Set(["base", "set", "cards", "card", "variation", "variations", "var", "vars"]);
/** Words that name the plain image variation; stripped from a kind only when
 *  what remains is a KNOWN kind or nothing. */
const IMAGE_WORDS = new Set(["image", "images", "photo", "photos", "picture", "pic"]);
const GENERIC = new Set([...NEVER_KIND, ...IMAGE_WORDS]);
const STOCK_WORDS = new Set(["chrome", "paper"]);
/**
 * CF-A-A-LEADING-FINISH-IS-A-FINISH (Drew ruling 20, 2026-09-08). A finish
 * word that appears BEFORE "variation" names the finish the variation comes
 * in, not a kind of variation: 2022 Topps Chrome's Witt #221 is sold as both
 * "Image Variation Refractor" and "Refractor Image Variation", and BCP lists
 * ONE card ("All Gimmicks are Refractors" -- Refractor is intrinsic to the
 * Tier 1 / Tier 2 variation, which our vocabulary spells Image Variation SP
 * and Image Variation SSP). Before this set existed, the split-at-first-
 * "variation" rule read the leading "refractor" as a KIND and minted
 * `refractor-image-variation` -- a third address for a card that already had
 * `image-variation`. These words are moved to the finish side instead, which
 * is where the same word lands when it follows ("image-variation-refractor").
 * ONLY bare finishes are listed: a finish that is part of a NAMED kind
 * ("Golden Mirror", "FrozenFractor", "Chrome Variation") is matched as a kind
 * before this set is consulted, and stock words (chrome / paper) are NOT here
 * because "Chrome Variation" is a real Heritage kind.
 */
/**
 * The subset of LEADING_FINISH that is INTRINSIC to the variation rather than
 * an axis crossed with it -- so a LEADING occurrence is dropped, not moved to
 * the tail. "All Gimmicks are Refractors" (BCP, 2022 Topps Chrome): there is
 * no non-Refractor Image Variation for the Refractor word to distinguish.
 *
 * Deliberately NARROW. `wave`, `speckle`, `prizm` and the rest stay out: those
 * name a REAL second card when they appear ("Image Variations Red Speckle
 * Refractor" is 20 distinct checklistcenter rows), and dropping a leading one
 * would fuse two pools. The fractor family is the only one BCP declares
 * intrinsic, and it is the only one measured as a pure duplicate address.
 */
const INTRINSIC_LEADING_FINISH = new Set(["refractor", "refractors"]);
const LEADING_FINISH = new Set([
  "refractor", "refractors", "xfractor", "x-fractor", "superfractor", "superfractors",
  "raywave", "wave", "prizm", "holo", "foil", "atomic", "mojo", "shimmer", "speckle", "sparkle",
]);
/** The pool's spellings for finish words that follow a variation. */
const FINISH_SPELLING: Readonly<Record<string, string>> = {
  superfractor: "SuperFractor", xfractor: "X-Fractor", raywave: "RayWave", frozenfractor: "FrozenFractor", logofractor: "Logofractor",
};

/**
 * Named kinds sellers and pages use. `standalone` kinds name the variation
 * even without the word "variation" ("Golden Mirror" alone IS the variation);
 * the others need it ("Clear", "Action" are ordinary words alone). `requires`
 * is context a kind needs: "Chrome Variation" is Heritage's kind — on every
 * other product "Chrome" is the product word ("2024 Topps Chrome Var #207"
 * is an image variation). Longest first so "team color border" claims before
 * "team color".
 */
const KINDS: ReadonlyArray<{ re: string; kind: string; standalone: boolean; requires?: RegExp }> = [
  { re: "team\\s+colou?r\\s+border", kind: "team color border", standalone: false },
  { re: "team\\s+colou?r", kind: "team color", standalone: false },
  { re: "golden\\s+mirror", kind: "golden mirror", standalone: true },
  { re: "true\\s+photo", kind: "true photo", standalone: true },
  { re: "lightboard\\s+logo", kind: "lightboard logo", standalone: true },
  { re: "murakami", kind: "murakami", standalone: true },
  { re: "frozen\\s?fractor", kind: "frozenfractor", standalone: false },
  { re: "throwback\\s+uniform", kind: "throwback uniform", standalone: false },
  { re: "throwback", kind: "throwback", standalone: false },
  { re: "nickname", kind: "nickname", standalone: false },
  { re: "colou?r\\s+swap", kind: "color swap", standalone: true },
  { re: "missing\\s+facsimile\\s+signature", kind: "missing facsimile signature", standalone: true },
  { re: "black\\s*(?:&|and)\\s*white", kind: "black & white", standalone: false },
  { re: "rookie\\s+design", kind: "rookie design", standalone: false },
  { re: "1991\\s+design", kind: "1991 design", standalone: false },
  { re: "wbc\\s+flag", kind: "wbc flag", standalone: true },
  { re: "retrofractor", kind: "retrofractor", standalone: false },
  { re: "award\\s+winners?", kind: "award winners", standalone: false },
  { re: "player\\s+number", kind: "player number", standalone: false },
  { re: "action", kind: "action", standalone: false },
  { re: "chrome", kind: "chrome", standalone: false, requires: /\bheritage\b/ },
  { re: "clear", kind: "clear", standalone: false },
  { re: "error", kind: "error", standalone: false },
  { re: "mini", kind: "mini", standalone: false },
];
/** Kinds whose name alone is unambiguous — a context-bound kind ("chrome",
 *  Heritage only) never strips the image word from "Chrome Image Variation",
 *  which is a different (Topps) card than Heritage's "Chrome Variation". */
const KNOWN_KIND_SLUGS = new Set(KINDS.filter((k) => !k.requires).map((k) => k.kind.replace(/\s+/g, "-")));

const VARIATION_WORD = /\b(?:variations?|var)\b/;
const IMAGE_VARIATION = /\b(?:image|photo|picture|pic)\s*(?:variations?|var)\b/;
// A tier word that is part of a CARD NUMBER ("#SSP-RC", 2003 Flair; "#SP-12")
// is not a marker: not preceded by "#", not followed by "-" + a code — the
// label form "SP-CHROME" / "SSP-PAPER" is read by LABEL_FORM first.
const SSP = /(?<!#\s*)\bssp\b(?!-[a-z0-9])|\bsuper\s+short\s+prints?\b/;
const SP_TIER = /(?<!#\s*)\bsp\b(?!-[a-z0-9])/;
const SHORT_PRINT = /\bshort\s+prints?\b/;
/** The grader-label form: "SP-CHROME", "SSP-CHROME", "SP Chrome", "SP-PAPER". */
const LABEL_FORM = /\b(ssp|sp)[\s-]+(chrome|paper)\b/;
/** A standalone "IV" token with UNICODE boundaries: not inside a word
 *  ("Givens"), not the "Iv" of "Iván" (74 of 77 pool hits), not a Roman
 *  numeral in a name ("Griffey IV" needs the context below). */
const IV_TOKEN = /(?:^|[^\p{L}\p{N}])iv(?=[^\p{L}\p{N}]|$)/u;
const IV_CONTEXT = /(?:^|[^\p{L}\p{N}])iv(?=[^\p{L}\p{N}]|$)[^\p{L}\p{N}]{0,3}(?:#|variation|var\b|photo|image|sp\b|ssp\b)|(?:#\s*[a-z]{0,4}-?\d{1,4}[a-z]?|variation|var|photo|image|\bsp|\bssp)[^\p{L}\p{N}]{0,3}(?:^|[^\p{L}\p{N}])iv(?=[^\p{L}\p{N}]|$)/u;

const titleCaseWord = (w: string): string =>
  FINISH_SPELLING[w] ?? (w === "ssp" ? "SSP" : w === "&" ? "&" : w === "wbc" ? "WBC" : /^[0-9]/.test(w) ? w : w[0].toUpperCase() + w.slice(1));
const titleCase = (s: string): string => s.split(/\s+/).filter(Boolean).map(titleCaseWord).join(" ");
/** "golden-mirror-variation-ssp" → "Golden Mirror Variation SSP". */
const titleCaseSlug = (slug: string): string => slug.split("-").filter(Boolean).map(titleCaseWord).join(" ");
const slugOf = (text: string): string => text.toLowerCase().replace(/[^a-z0-9&]+/g, "-").replace(/^-+|-+$/g, "");

/** The display name for a kind + tier (+ a grader-label stock). */
export function variationDisplayName(kind: string | null, tier: VariationTier | null, stock: VariationStock | null = null): string {
  const head = kind ? `${titleCase(kind)} Variation` : "Image Variation";
  return `${head}${tier === "ssp" ? " SSP" : ""}${stock ? ` ${titleCase(stock)}` : ""}`;
}

/**
 * Read the variation a listing title (lower-cased) names. Strong forms name
 * the finish outright; weak markers ("IV" out of context, bare "SP" / "SSP" /
 * "Short Print") are reported for the seam to corroborate against the
 * product's checklist — never guessed here.
 */
export function readVariationFromTitle(lower: string): VariationRead {
  const t = String(lower ?? "").toLowerCase();
  const consumed: string[] = [];
  let tier: VariationTier | null = SSP.test(t) ? "ssp" : null;
  let stock: VariationStock | null = null;
  let kind: string | null = null;
  let strong = false;
  // The grader-label form is the strongest read: "SP-CHROME" IS the finish.
  const label = t.match(LABEL_FORM);
  if (label) { strong = true; tier = label[1] === "ssp" ? "ssp" : tier; stock = label[2] as VariationStock; consumed.push(label[0]); }
  for (const k of KINDS) {
    if (k.requires && !k.requires.test(t)) continue;
    const m = t.match(new RegExp(`\\b${k.re}\\b`));
    if (!m) continue;
    // A kind names the variation when standalone, or when a variation word /
    // tier word sits within a few tokens of it.
    const near = new RegExp(`\\b${k.re}\\b[^a-z0-9]{0,3}(?:image\\s+|photo\\s+)?(?:variations?|var|sp|ssp)\\b|\\b(?:variations?|var|sp|ssp)\\b[^a-z0-9]{0,3}${k.re}\\b`);
    if (k.standalone || near.test(t)) { kind = k.kind; strong = true; consumed.push(m[0]); break; }
  }
  const iv = t.match(IMAGE_VARIATION) ?? t.match(VARIATION_WORD);
  if (iv) { strong = true; consumed.push(iv[0]); }
  if (!strong && IV_TOKEN.test(t) && IV_CONTEXT.test(t)) { strong = true; consumed.push("iv"); }
  if (strong) {
    const ssp = t.match(SSP); if (ssp) consumed.push(ssp[0]);
    const sp = t.match(SP_TIER); if (sp) consumed.push(sp[0]);
    const shortPrint = t.match(SHORT_PRINT); if (shortPrint) consumed.push(shortPrint[0]);
    const words = consumed.flatMap((c) => c.split(/[\s&-]+/)).filter(Boolean);
    return { finish: variationDisplayName(kind, tier, stock), kind, tier, stock, marker: null, consumed, words };
  }
  // Weak markers, for the seam.
  let marker: VariationMarker | null = null;
  if (tier === "ssp") marker = "ssp";
  else if (IV_TOKEN.test(t)) marker = "iv";
  else if (SHORT_PRINT.test(t)) marker = "short-print";
  else if (SP_TIER.test(t)) marker = "sp";
  return { finish: null, kind: null, tier, stock: null, marker, consumed: [], words: [] };
}

/** The display name for a canonical variation slug ("image-variation-ssp" →
 *  "Image Variation SSP"). Null when the slug is not a variation. */
export function variationNameFromSlug(slug: string | null | undefined): string | null {
  const s = normalizeVariationSlug(String(slug ?? ""));
  return isVariationSlug(s) ? titleCaseSlug(s) : null;
}

/**
 * Canonicalise a parallel / finish TEXT that carries a variation word (a
 * holding's parallel field, a checklist section's finish, a grader label's
 * descriptor). Returns the display name, or null when the text names no
 * variation. A bare "SP" / "Short Print" is NOT a variation here (Heritage's
 * short print is the base card); a bare "SSP" and the label forms are.
 */
export function canonicalVariationName(text: string | null | undefined): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (/^(ssp|super\s+short\s+prints?)$/.test(lower)) return "Image Variation SSP";
  if (/^(iv|image\s+var|photo\s+var)$/.test(lower)) return "Image Variation";
  if (/^(ssp|sp)[\s-]*(chrome|paper)$/.test(lower)) return titleCaseSlug(normalizeVariationSlug(slugOf(lower)));
  if (!VARIATION_WORD.test(lower) && !IMAGE_VARIATION.test(lower)) return null;
  const slug = normalizeVariationSlug(slugOf(lower));
  return isVariationSlug(slug) ? titleCaseSlug(slug) : null;
}

/**
 * The slug layer. Given an already-slugified parallel ("image-variations",
 * "golden-mirror-image-variation-short-print", "ssp", "iv", "sp-chrome"), the
 * canonical form per the vocabulary above. Anything without a variation word
 * is returned unchanged, except: "ssp" → image-variation-ssp, "iv" →
 * image-variation, the label forms, and "short-prints" → short-print. A bare
 * "sp" stays "sp" (the catalog's own spelling for a short-printed base).
 */
export function normalizeVariationSlug(slug: string): string {
  let s = String(slug ?? "").toLowerCase().replace(/^-+|-+$/g, "");
  if (!s) return s;
  if (/^(ssp|super-short-prints?)$/.test(s)) return "image-variation-ssp";
  if (s === "iv" || s === "image-var" || s === "photo-var") return "image-variation";
  const label = s.match(/^(ssp|sp)-(chrome|paper)$/);
  if (label) return `image-variation${label[1] === "ssp" ? "-ssp" : ""}-${label[2]}`;
  if (/^short-prints?$/.test(s)) return "short-print";
  if (!/(^|-)(variations?|var)(-|$)/.test(s)) return s;
  s = s.replace(/(^|-)variations(-|$)/g, "$1variation$2").replace(/(^|-)var(-|$)/g, "$1variation$2");
  // Tiers: SSP is spelled; SP is the default and is not.
  let ssp = false;
  if (/(^|-)(ssp|super-short-prints?)(-|$)/.test(s)) { ssp = true; s = s.replace(/(^|-)(ssp|super-short-prints?)(?=-|$)/g, ""); }
  s = s.replace(/(^|-)(sp|short-prints?)(?=-|$)/g, "");
  s = s.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  // Split at the FIRST "variation": what precedes it is the kind, what
  // follows is a finish the variation comes in.
  const parts = s.split("-");
  const at = parts.indexOf("variation");
  const beforeAll = parts.slice(0, at).filter((w) => !NEVER_KIND.has(w));
  const after = parts.slice(at + 1).filter((w) => w !== "variation" && !GENERIC.has(w));
  // A leading finish is a finish, not a kind -- but only when what remains in
  // front is not itself a known kind, so "Chrome Variation" and "Golden
  // Mirror Image Variation" keep every word they have.
  const leading = beforeAll.filter((w) => LEADING_FINISH.has(w));
  const beforeKindOnly = beforeAll.filter((w) => !LEADING_FINISH.has(w));
  const remainderIsKind =
    beforeKindOnly.length > 0 &&
    (KNOWN_KIND_SLUGS.has(beforeKindOnly.join("-")) ||
      KNOWN_KIND_SLUGS.has(beforeKindOnly.filter((w) => !IMAGE_WORDS.has(w)).join("-")) ||
      beforeKindOnly.every((w) => IMAGE_WORDS.has(w)));
  const before = leading.length > 0 && (remainderIsKind || beforeKindOnly.length === 0) ? beforeKindOnly : beforeAll;
  const movedFinish = before === beforeKindOnly ? leading : [];
  const withoutImageWords = before.filter((w) => !IMAGE_WORDS.has(w));
  const kindWords = withoutImageWords.length === 0 || KNOWN_KIND_SLUGS.has(withoutImageWords.join("-")) ? withoutImageWords : before;
  const kind = kindWords.length ? kindWords.join("-") : "image";
  // CF-AN-INTRINSIC-FINISH-IS-NOT-AN-ADDRESS (Drew ruling 20, 2026-09-08 --
  // COMPLETING #2012). The LEADING_FINISH move above unified the two title
  // spellings, and unified them onto the WRONG ADDRESS. BCP's own note on the
  // heading is "All Gimmicks are Refractors": Refractor is INTRINSIC to the
  // Image Variation, not a finish axis it is crossed with. Our vocabulary for
  // that card is `Image Variation SP` (Tier 1) and `Image Variation SSP`
  // (Tier 2), and SP is the default tier the slug does not spell -- so the
  // checklist row's address is the BARE `image-variation`.
  //
  // Measured on 2022 Topps Chrome (2026-09-09, card_catalog):
  //
  //   Image Variation SP      20  beckett-scraped-2026-09-01  -> :image-variation:
  //   Image Variation SSP      5  beckett-scraped-2026-09-01  -> :image-variation-ssp:
  //   Image Variation Refractor 26  ingest-auto-seed          -> :image-variation-refractor:
  //   Image Variation Refractor 23  ingest-auto-seed-graded    -> :image-variation-refractor:
  //
  // Both title spellings normalised to `image-variation-refractor`, which is
  // the address ONLY the self-derived seeds occupy. Holding 2b62a93f
  // (`parallel: "Refractor Image Variation"`) therefore re-derived onto an
  // ingest-auto-seed row and was reported "checklist-backed" -- a row we
  // minted from our own sales confirming the sale that minted it.
  //
  // So an intrinsic finish that arrived BEFORE the variation word is dropped
  // rather than re-appended. It is NOT dropped when it FOLLOWS the variation
  // word: `chromeRefractorSuffixForVariation` (below) documents that a finish
  // named after the variation is chrome's colour shorthand and a real second
  // card ("Image Variation Gold Speckle Refractor"), and `after` is left
  // untouched here for exactly that reason. The move-to-tail therefore only
  // ever collapses a DUPLICATE address; it never merges two real cards.
  const tail = [...after];
  for (const w of movedFinish) {
    if (INTRINSIC_LEADING_FINISH.has(w)) continue;
    if (!tail.includes(w)) tail.push(w);
  }
  return [kind, "variation", ...(ssp ? ["ssp"] : []), ...tail].join("-");
}

/** True when a parallel slug names a member of the family. */
export function isVariationSlug(slug: string | null | undefined): boolean {
  const s = String(slug ?? "").toLowerCase();
  return /(^|-)variation(-|$)/.test(s);
}

/**
 * CF-A-VARIATION-IS-NOT-A-REFRACTOR. On chrome stock the slug grammar
 * appends "-refractor" to every non-base parallel (Blue ≡ Blue Refractor).
 * A variation is the base-finish card with a different photo, so a bare
 * variation slug keeps its name — and so does one that only names its stock
 * or tier ("image-variation-chrome"); only a finish named AFTER the variation
 * word ("Image Variation Gold Speckle") is chrome's colour shorthand and
 * takes the suffix. Returns null for a non-variation slug (the caller's own
 * rule applies).
 */
export function chromeRefractorSuffixForVariation(slug: string): string | null {
  const s = String(slug ?? "");
  if (!isVariationSlug(s)) return null;
  const parts = s.split("-");
  const at = parts.indexOf("variation");
  const after = parts.slice(at + 1).filter((w) => w !== "ssp" && !STOCK_WORDS.has(w) && w !== "auto");
  if (after.length === 0) return s;
  if (after.some((w) => w === "refractor" || /fractor$/.test(w))) return s;
  return `${s}-refractor`;
}

/**
 * The seam's corroboration. A weak marker in a title becomes a variation only
 * when the product's checklist holds one for that card — and only the PLAIN
 * image variation (a named kind needs its name; a bare "SP" in Heritage is
 * the short-printed base card, never its Action Variation):
 *   ssp                 → the card's `image-variation-ssp` row, else its
 *                         plain `image-variation` row
 *   sp / iv / short-print → the card's plain `image-variation` row
 * `parallelSlugs` are the catalog's parallel slugs for (sport, year, setKey,
 * cardNumber). Returns the parallel slug to adopt, or null.
 */
export function pickVariationForMarker(marker: VariationMarker | null | undefined, parallelSlugs: ReadonlyArray<string>): string | null {
  if (!marker) return null;
  const slugs = new Set(parallelSlugs.map((p) => normalizeVariationSlug(String(p ?? "").toLowerCase())));
  if (marker === "ssp" && slugs.has("image-variation-ssp")) return "image-variation-ssp";
  return slugs.has("image-variation") ? "image-variation" : null;
}

/**
 * A grader label says "SP-CHROME"; the product's checklist may or may not
 * distinguish a chrome and a paper variation. Where it does not — its rows
 * hold `image-variation` and no `-chrome` / `-paper` form — the stock word
 * is the label's, not the card's, and the finish is the plain variation.
 * Where the checklist has no variation row at all the text stands as read.
 * `parallelSlugs` are the catalog's parallel slugs for the card.
 */
export function reduceVariationStockToCatalog(finishText: string | null | undefined, parallelSlugs: ReadonlyArray<string>): string | null {
  const canon = canonicalVariationName(finishText);
  if (!canon) return null;
  const slug = normalizeVariationSlug(slugOf(canon));
  const parts = slug.split("-");
  if (!parts.some((w) => STOCK_WORDS.has(w))) return canon;
  const held = new Set(parallelSlugs.map((p) => normalizeVariationSlug(String(p ?? "").toLowerCase())));
  if (held.has(slug)) return canon;
  const stripped = parts.filter((w) => !STOCK_WORDS.has(w)).join("-");
  return held.has(stripped) ? titleCaseSlug(stripped) : canon;
}

/**
 * Checklist pages. Is this Set value / subset title / heading a variation
 * section, and what finish does it name? The anchor section's own words come
 * off the front; "Base", "Set", "Cards" are never part of the finish; plural
 * to singular; a bare "Variation(s)" IS the image variation; "Super Short
 * Prints" is the SSP tier. Returns null for a non-variation section.
 *
 *   "Image Variations"                     → "Image Variation"
 *   "Base Image Variation Set"             → "Image Variation"
 *   "Image Variations SuperFractor"        → "Image Variation SuperFractor"
 *   "Golden Mirror Image Variations"       → "Golden Mirror Variation"
 *   "Base SP Variation Set"                → "Image Variation"
 *   "Base Super Short Print Variation"     → "Image Variation SSP"
 *   "Super Short Prints"                   → "Image Variation SSP"
 *   "Variations" (under an insert's name)  → "Image Variation"
 *   "Short Prints" / "SP"                  → null (a scarce base card, not a variation)
 */
export function variationFinishOfSection(sectionText: string | null | undefined, anchorSection: string | null = null): string | null {
  let t = String(sectionText ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (anchorSection) {
    const a = String(anchorSection).replace(/\s+/g, " ").trim();
    if (a && t.toLowerCase().startsWith(a.toLowerCase() + " ")) t = t.slice(a.length + 1).trim();
  }
  t = t.replace(/^\d{4}\s+[^-]*-\s*/, "").replace(/\s+(set|checklist)$/i, "").trim();
  const lower = t.toLowerCase();
  if (!VARIATION_WORD.test(lower) && !IMAGE_VARIATION.test(lower) && !SSP.test(lower)) return null;
  const slug = normalizeVariationSlug(slugOf(lower));
  if (!isVariationSlug(slug)) return null;
  // The plain variation, a tier of it, or a KNOWN kind: the vocabulary's own
  // spelling. Anything else keeps the page's words — singular, without a
  // leading "Base" — apostrophes and hyphens included ("Prospector's Special
  // Die-Cut Variation"), because the page is the authority on its own name.
  const parts = slug.split("-");
  const at = parts.indexOf("variation");
  const after = parts.slice(at + 1).filter((w) => w !== "ssp");
  const kind = parts.slice(0, at).join("-");
  if (after.length === 0 && (kind === "image" || KNOWN_KIND_SLUGS.has(kind))) return titleCaseSlug(slug);
  return t.replace(/^base\s+/i, "")
    .replace(/\b(v)ariations\b/gi, (_m, v: string) => `${v}ariation`)
    .replace(/\b(image|photo)\s+(v)ariation\b/gi, (_m, _w: string, v: string) => `Image ${v}ariation`)
    .replace(/\s+/g, " ").trim();
}
