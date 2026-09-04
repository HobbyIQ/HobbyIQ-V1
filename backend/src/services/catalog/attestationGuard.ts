// CF-DO-NOT-ATTEST-A-BASE-ROW-OVER-A-VARIANT (Drew, 2026-08-24).
//
// Attesting is a CREATION act, so it is held to a stricter standard than
// matching. Matching a sale wrongly puts one bad comp in a pool; attesting
// wrongly mints a catalog row that every future sale of that card will match
// against, and a confidently-wrong row is invisible to the only-improve sweep
// forever.
//
// The failure this exists to stop, measured on rows already written by
// attest-unnumbered-by-player: 878 of 7,666 rows (11.5%), carrying 18,134
// sales, were minted as plain `:base:no-auto` from titles that plainly named a
// variant --
//
//   "2024 Panini Photogenic Progressions Derrick Henry Blue Foil /99"
//   "2023 Panini Black Tank Bigsby Rookie Auto /50 No 125"
//   "ONEIL CRUZ ... UNDER WRAPS 8X10 ORANGE AUTO AUTOGRAPH 21/25"
//
// -- because that script hardcoded parallel "Base", isAuto false and printRun
// null rather than carrying what the parser found. A Blue Foil /99 sale filed
// into the base pool does not merely fail to price itself: it MOVES THE BASE
// PRICE. Leaving the sale unresolved is strictly better, because an unresolved
// sale is invisible rather than wrong.
//
// isParserProbablyWrong is the shipped persist-time rule and fires on colour +
// parallel word together. It is necessary but not sufficient here: it does not
// fire on "Crusade Camo" (no colour word), on a bare "/99", or on a dropped
// auto. This adds those three.
import { isParserProbablyWrong } from "../portfolioiq/parserSuspicionDetector";
/** ONE REGEX SOURCE (CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE, 2026-09-04). This
 *  file used to carry its own copy of the auto-in-title shape, with the same
 *  unbounded `autograph` defect: a title ending "... AutographDen" made the
 *  guard suspect the parser had DROPPED an auto on a plain base card. The
 *  witness now comes from parseTitleIdentity, which is the authority, so the
 *  two cannot drift apart again. */
import { AUTO_RE as AUTO_IN_TITLE_RE, autographWitnessIsSellerNameOnly } from "../portfolioiq/parseTitleIdentity.service";

/** Parallel vocabulary that carries no colour word with it, so the shipped
 *  colour+context detector cannot see it. */
const PARALLEL_HINT_RE =
  /\b(camo|mojo|disco|hyper|scope|sparkle|velocity|tie[- ]?dye|speckle|atomic|cracked[- ]ice|reactive|shimmer|wave|prizm|refractor|x-?fractor|holo(?:foil|gram)?|foil|lava|pulsar|snakeskin|dragon[- ]scale|kaleidoscope|nebula|genesis|fast[- ]break|die[- ]?cut|sapphire|superfractor|negative|prismatic|rainbow|starburst|downtown|kaboom|[a-z]+fractor)\b/i;

/** A print run stated as "/99" or "21/25". Not a card number: requires the
 *  slash. Capped at 5 digits so a date or a cert number cannot match. */
const PRINT_RUN_IN_TITLE_RE = /\/\s?(\d{1,5})\b/;

export interface AttestCandidate {
  title: string | null | undefined;
  /** The sale's own setName. Subtracted from the title before the colour test,
   *  because a colour in the PRODUCT name is not a parallel: "2023 Panini Black
   *  Tank Bigsby Rookie Auto /50" is a Panini Black base card, and reading its
   *  "black" as a parallel holds back a correctly-parsed row for no reason. */
  setName?: string | null;
  parsedParallel?: string | null;
  parsedIsAuto?: boolean | null;
  parsedPrintRun?: number | null;
}

/**
 * True when the title names a variant that the parsed identity does not carry,
 * so minting a row from it would flatten a real distinction.
 *
 * Returns a reason rather than a bare boolean so the caller can report WHY a
 * sale was held back — a held sale is a lead for the next parser fix, and a
 * silent skip is indistinguishable from having nothing to do.
 */
/** Drop every word of the product name from the title. Word-set removal, not a
 *  regex build: a setName can contain any character, and interpolating one into
 *  a pattern is how a stray "(" becomes a crash. */
function subtractSetName(title: string, setName: string | null | undefined): string {
  const set = String(setName ?? "").toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 2);
  if (!set.length) return title;
  const drop = new Set(set);
  return title.split(/(\s+)/).filter((w) => !drop.has(w.toLowerCase().replace(/[^a-z0-9]/gi, ""))).join("");
}

export function unparsedVariantReason(c: AttestCandidate): string | null {
  const title = String(c.title ?? "");
  if (!title.trim()) return null;

  const parallel = String(c.parsedParallel ?? "").trim().toLowerCase();
  const parallelIsBase = !parallel || parallel === "base";

  if (parallelIsBase) {
    const withoutSet = subtractSetName(title, c.setName);
    if (isParserProbablyWrong({ parsedParallel: "Base", title: withoutSet })) return "colour+parallel word";
    if (PARALLEL_HINT_RE.test(withoutSet)) return "parallel word";
  }
  if (!c.parsedIsAuto && AUTO_IN_TITLE_RE.test(title) && !autographWitnessIsSellerNameOnly(title)) {
    return "auto in title";
  }
  if (!c.parsedPrintRun && PRINT_RUN_IN_TITLE_RE.test(title)) return "print run in title";
  return null;
}

/** Convenience boolean for call sites that do not report the reason. */
export function wouldFlattenAVariant(c: AttestCandidate): boolean {
  return unparsedVariantReason(c) !== null;
}
