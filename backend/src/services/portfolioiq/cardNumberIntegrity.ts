// CF-A-CARD-NUMBER-IS-NOT-A-GRADE (D28, Drew 2026-08-30).
//
// Harrison's holding 2925db74 -- "2018 Topps Chrome Refractor PSA 10, Shohei
// Ohtani, pitching", which is the standard #150 Refractor -- sat on
// `hiq:baseball:2018:topps-chrome:9:refractor:no-auto` and priced from two
// sales keyed to "#9": a Paul DeJong 1983 35th Anniversary Refractor #83T-22
// and an Ohtani 1983 Topps Refractor #83T-6. All three took "9" from the words
// "PSA 9" in a title whose real number the parser could not read.
//
// parseTitleIdentity already refuses grader digits on ITS path
// (CF-A-GRADE-IS-NOT-A-CARD-NUMBER, 2026-08-24). It is not the only path. The
// CH converter copies `row.number` verbatim, the eBay title parser has its own
// regexes, the OCR extractor has a third, the import takes the user's field,
// and the LLM enricher answers with whatever it read. Five derivations, one
// invariant, and nowhere it was stated once.
//
// This module is that statement. It is pure: no Cosmos, no network, no clock.
// It answers one question -- given a candidate card number and the title the
// sale carries, what is the card number? -- and it answers it the same way for
// every emitter, so a shape fixed here cannot come back through a door nobody
// was watching.
//
// The rules, in the order they are applied:
//
//   1. An explicit `#X` in the title WINS. A vendor field that disagrees is
//      not silently overwritten: the verdict says so (`vendorDisagrees`) and
//      the caller logs `card_number_vendor_disagrees`.
//   2. A number is never a grader's digit -- "PSA 9", "BGS 9.5", "CGC 10",
//      "SGC 8", "GEM MT 10", "MINT 9".
//   3. A number is never a print run -- neither the "/N" form nor the bare N
//      of a "/N" the title states. (In a TCG vertical "044/193" IS the card
//      number; the caller says which vertical it is, per
//      CF-SERIAL-IS-NOT-A-CARDNUMBER.)
//   4. A number is never a 4-digit year in 1900-2035.
//   5. A number is never an ordinal -- the "1st Bowman" trap, "2nd".
//   6. A number is never a lot count -- "LOT OF 2", "2 CARD LOT".
//
// Every rejection requires the title to actually say the thing. A bare "9"
// with a title that never mentions a grade is left alone: this guard removes
// numbers that provably came from somewhere else, and it is not in the
// business of guessing that a number is wrong.

// D23 already settled that a card-number comparison is hyphen- and
// case-insensitive (CF-THE-ID-CARRIES-THE-PRODUCT, ruling d: bd152 = BD-152).
// This module re-exports that one rather than declaring a second: the canary
// found "BCP-10" stored against a title printing "#BCP10" on 1.13% of the last
// six hours of live rows, and a SECOND spelling rule would have been a second
// place for that answer to drift.
export { sameCardNumber } from "./hobbyIqCardId.service.js";
import { sameCardNumber } from "./hobbyIqCardId.service.js";

/** Why a candidate card number was refused. */
export type CardNumberRejection =
  | "grader-digit"
  | "print-run-slash"
  | "print-run-bare"
  | "year"
  | "ordinal"
  | "lot-count";

/** Where the kept number came from. */
export type CardNumberSource = "title" | "candidate" | "none";

export interface CardNumberVerdict {
  /** The number to write. `null` means the title does not state one and the
   *  candidate could not be trusted -- the caller parks the row rather than
   *  keying it to a card it is not. */
  cardNumber: string | null;
  /** Set when the candidate was refused. `null` when it was kept, and `null`
   *  when the title's explicit number simply outranked it. */
  rejected: CardNumberRejection | null;
  /** The explicit `#X` the title states, when it states one. */
  titleNumber: string | null;
  /** The title states an explicit `#X` and the candidate said something else.
   *  The title wins; this is the counter and the log line
   *  (`card_number_vendor_disagrees`). */
  vendorDisagrees: boolean;
  source: CardNumberSource;
}

export interface CardNumberOptions {
  /** True for Pokemon / Yu-Gi-Oh / any TCG vertical, where `POS/TOTAL` is the
   *  printed card number rather than a serial. Defaults to false: in sports a
   *  slash is a print run, every time. */
  isTcg?: boolean;
}

/** Verticals whose printed card number carries a slash. Mirrors the vertical
 *  tags persistVendorSalesToPool writes. */
const TCG_VERTICALS = new Set(["pokemon", "yugioh", "tcg-other", "anime-tcg", "mtg", "lorcana", "one-piece"]);
export function isTcgVertical(vertical: string | null | undefined): boolean {
  return TCG_VERTICALS.has(String(vertical ?? "").trim().toLowerCase());
}

/** Grading companies, plus the condition words that stand in for one on a
 *  slab label ("GEM MT 10", "MINT 9"). Same vocabulary as
 *  parseTitleIdentity's GRADER_BEFORE_NUMBER so the two cannot drift. */
const GRADER_TOKENS = [
  "PSA", "BGS", "SGC", "CGC", "BVG", "HGA", "KSA", "GMA", "ACE", "TAG", "RCG",
  "ISA", "CSG", "AGS", "GEM", "MINT", "PRISTINE", "GRADE", "GRADED", "MT",
  "NM", "AUTHENTIC", "GEM MT", "GEM MINT", "NM MT", "NM-MT", "GEM-MT",
];

const trim = (v: unknown): string => String(v ?? "").trim();
/** A candidate the rules can reason about: bare digits, or digits with one
 *  decimal (a half grade, "9.5"). Everything else -- BCP-16, 83T-22, CPA-EW,
 *  US175 -- is a real SKU shape and no rule below applies to it. */
const asBareNumber = (v: string): string | null => (/^\d{1,4}(?:\.\d)?$/.test(v) ? v : null);
/** Regex-safe copy of a token. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the title state this exact number with a `#` in front of it? That is
 *  the seller saying "this is the card number", and it settles every rule. */
export function titleStatesHash(title: string | null | undefined, num: string): boolean {
  const t = trim(title);
  if (!t || !num) return false;
  return new RegExp(`#\\s*0*${esc(num)}\\b`, "i").test(t);
}

// An explicit `#X`. The shape vocabulary is DEFAULT_CARD_NUMBER_RE's, widened
// by what the measured titles actually print -- because a `#` this reader
// cannot parse falls through to the vendor's digit, which is the whole bug:
//
//   "2025 TOPPS STARS OF MLB #SMLB10 ... PSA 10"    -> SMLB10, not 10
//   "2025 Topps Chrome 1990 Topps #90CB-7 - PSA 10" -> 90CB-7, not 10
//   "Ohtani 1983 Topps Refractor PSA 10 #83T-6"     -> 83T-6, not 10
//
// Three alternatives, longest first (JS alternation is ordered):
//   1. a hyphenated SKU, either half alphanumeric -- BCP-16, 83T-22, 90CB-7
//   2. a SLASHED SKU whose halves are not both numbers -- AAC/BG, N/A. Fleer
//      Avant's dual-player inserts are numbered exactly this way, and 12,099
//      pool rows carry one; a rule that called every slash a print run would
//      have thrown those away (measured 2026-08-30).
//   3. a glued alpha SKU                          -- US175, SMLB10, USC35
//   4. a bare number with an optional letter      -- 150, 9, 22A
const EXPLICIT_HASH_RE =
  /#\s*([A-Z0-9]{1,6}-[A-Z0-9]{1,8}|[A-Z]{1,5}\/[A-Z0-9]{1,6}|[A-Z]{2,6}\d{1,4}[A-Z]?|\d{1,4}[A-Z]?)\b/gi;
// "#PSA10" / "#BGS 9" is a grade with a hash in front of it, not a SKU.
const HASHED_GRADER_RE = /^(PSA|BGS|SGC|CGC|BVG|HGA|GEM|MINT|GRADE|GRADED)[-\s]*\d/i;
// "Serial #", "numbered #", "#'d" introduce a PRINT RUN, not a card number.
const SERIAL_LEAD_RE = /(serial|numbered|#'?d|limited|edition\s+of)\s*$/i;

/**
 * The explicit card number the title states, or null.
 *
 * Refuses the three ways a `#` in a title is not a card number:
 *   - it follows "serial" / "numbered" / "#'d"        -> a print run
 *   - it is followed by "/N" outside a TCG vertical   -> "#25/99" is a serial
 *   - it is a 4-digit year                            -> "#2018" is the set
 */
export function explicitTitleCardNumber(
  title: string | null | undefined,
  opts: CardNumberOptions = {},
): string | null {
  const t = trim(title);
  if (!t) return null;
  EXPLICIT_HASH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPLICIT_HASH_RE.exec(t)) !== null) {
    const tok = m[1].toUpperCase();
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    if (SERIAL_LEAD_RE.test(before)) continue;
    if (HASHED_GRADER_RE.test(tok)) continue;
    const after = t.slice(m.index + m[0].length);
    if (opts.isTcg) {
      const tot = after.match(/^\s*\/\s*(\d{1,3})\b/);
      if (tot && /^\d{1,3}$/.test(tok)) return `${tok}/${tot[1]}`;   // "#044/193"
    } else if (/^\s*\/\s*\d/.test(after)) {
      continue;                                                       // "#25/99" is a serial
    }
    if (/^\d{4}$/.test(tok) && Number(tok) >= 1900 && Number(tok) <= 2035) continue;
    return tok;
  }
  return null;
}

/** "PSA 9", "BGS 9.5", "CGC 10", "SGC 8", "GEM MT 10", "MINT 9" -- the title
 *  says this number is a GRADE. */
export function isGraderDigit(title: string | null | undefined, num: string): boolean {
  const t = trim(title);
  const n = asBareNumber(num);
  if (!t || !n) return false;
  if (Number(n) > 10) return false;                 // grades run 1..10
  if (titleStatesHash(t, n)) return false;          // the seller said it is the card number
  let graderAdjacent = false;
  for (const g of GRADER_TOKENS) {
    if (new RegExp(`\\b${esc(g)}\\b[\\s.:-]*${esc(n)}(?!\\d)(?!\\s*\\/)`, "i").test(t)) { graderAdjacent = true; break; }
  }
  if (!graderAdjacent) return false;
  // The upper bound the spec named: "a real #9 graded PSA 9 also matches". The
  // discriminator is whether the title says the number TWICE. In
  //   "2023 Topps Chrome Elly De La Cruz 10 PSA 10"
  // the first "10" follows a player name, not a grader — the seller stated the
  // card number and the grade, and only one of them is the grade. One
  // occurrence away from every grader token is enough to keep it.
  return !statedAwayFromAGrader(t, n);
}

/** Does this bare number appear at least once NOT preceded by a grader or a
 *  condition word? Written as a token walk, like parseTitleIdentity's
 *  standaloneCardNumber — a preceding-token set membership has no escape bugs
 *  and no lookbehind. */
function statedAwayFromAGrader(title: string, n: string): boolean {
  const toks = title.split(/\s+/).filter(Boolean);
  const graders = new Set(GRADER_TOKENS.map((g) => g.replace(/[^A-Za-z]/g, "").toUpperCase()));
  for (let i = 0; i < toks.length; i++) {
    // Strip surrounding PUNCTUATION only. A token that is not JUST this number
    // -- 2010, 9.5, 10/82, and above all "#SMLB10" -- is a different thing
    // that happens to contain the digits, and counting it would keep the very
    // grade this rule exists to refuse.
    if (toks[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") !== n) continue;
    const prev = i > 0 ? toks[i - 1].toUpperCase().replace(/[^A-Z]/g, "") : "";
    if (!prev || !graders.has(prev)) return true;
  }
  return false;
}

/**
 * The candidate IS a print run: "108/165" outside a TCG vertical.
 *
 * A slash is NOT enough. Measured 2026-08-30: of 25,093 pool rows whose
 * cardNumber contains "/", a large share are real SKUs -- "2003 Fleer Avant
 * #AAC/BG" (a dual-player insert numbered by both players' initials) and the
 * "N/A" the slug builder already reads as unnumbered. Only a NUMBER over a
 * NUMBER is a serial, and only outside a TCG vertical
 * (CF-SERIAL-IS-NOT-A-CARDNUMBER).
 */
export function isPrintRunSlash(num: string, opts: CardNumberOptions = {}): boolean {
  if (!/^\s*\d{1,4}\s*\/\s*\d{1,5}\s*$/.test(num)) return false;
  if (!opts.isTcg) return true;
  // Even in TCG only POS/TOTAL with both bounded is a card number; "1/1" and
  // "22/30" reaching a TCG row are still serials, but the vertical is the
  // caller's call and the shape check is all this can add.
  const m = num.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
  return !(m && Number(m[1]) > 0 && Number(m[1]) <= 400 && Number(m[2]) > 0 && Number(m[2]) <= 400);
}

/** The bare N of a "/N" the title states: cardNumber "25" from "... /25". */
export function isBarePrintRun(title: string | null | undefined, num: string): boolean {
  const t = trim(title);
  const n = asBareNumber(num);
  if (!t || !n || n.includes(".")) return false;
  if (titleStatesHash(t, n)) return false;
  return new RegExp(`\\/\\s*0*${esc(n)}\\b`, "i").test(t);
}

/** A 4-digit year is the set's year, not card #2018. */
export function isYearNumber(title: string | null | undefined, num: string): boolean {
  if (!/^\d{4}$/.test(num)) return false;
  const n = Number(num);
  if (n < 1900 || n > 2035) return false;
  return !titleStatesHash(title, num);
}

/** The "1st Bowman" trap: cardNumber "1" from the words "1st Bowman". */
export function isOrdinal(title: string | null | undefined, num: string): boolean {
  const t = trim(title);
  const n = asBareNumber(num);
  if (!t || !n || n.includes(".")) return false;
  if (titleStatesHash(t, n)) return false;
  return new RegExp(`\\b0*${esc(n)}(st|nd|rd|th)\\b`, "i").test(t);
}

/** "LOT OF 2", "2 CARD LOT", "(2) LOT" -- a count of cards, not a card. */
export function isLotCount(title: string | null | undefined, num: string): boolean {
  const t = trim(title);
  const n = asBareNumber(num);
  if (!t || !n || n.includes(".")) return false;
  if (titleStatesHash(t, n)) return false;
  const e = esc(n);
  return new RegExp(`\\blots?\\s+of\\s+0*${e}\\b`, "i").test(t)
    || new RegExp(`\\b0*${e}\\s+(?:card|cards|ct|pc|pcs)\\s+lot\\b`, "i").test(t)
    || new RegExp(`\\(\\s*0*${e}\\s*\\)\\s*(?:card|cards)?\\s*lot\\b`, "i").test(t)
    || new RegExp(`\\blot\\b[^#]{0,12}\\b0*${e}\\s+(?:card|cards)\\b`, "i").test(t);
}

/**
 * The one ruling. Give it whatever the emitter was about to write and the
 * title the sale carries; it returns the number to write and why.
 *
 * The title's explicit `#X` outranks the candidate ALWAYS -- that is the
 * ruling, and `vendorDisagrees` is how the caller counts the times it mattered.
 * With no explicit `#X`, the candidate stands unless the title shows it came
 * from a grade, a print run, a year, an ordinal or a lot count.
 */
export function judgeCardNumber(
  candidate: string | null | undefined,
  title: string | null | undefined,
  opts: CardNumberOptions = {},
): CardNumberVerdict {
  const cand = trim(candidate).replace(/^#\s*/, "").toUpperCase();
  const titleNumber = explicitTitleCardNumber(title, opts);

  if (titleNumber) {
    // The same number spelled two ways is not a disagreement, and the STORED
    // spelling wins there -- see sameCardNumber. Only a genuinely different
    // number is the title overruling the vendor.
    if (cand !== "" && sameCardNumber(cand, titleNumber)) {
      return { cardNumber: cand, rejected: null, titleNumber, vendorDisagrees: false, source: "candidate" };
    }
    const disagrees = cand !== "";
    return { cardNumber: titleNumber, rejected: null, titleNumber, vendorDisagrees: disagrees, source: "title" };
  }
  if (!cand) return { cardNumber: null, rejected: null, titleNumber: null, vendorDisagrees: false, source: "none" };

  const rejected: CardNumberRejection | null =
    isPrintRunSlash(cand, opts) ? "print-run-slash"
      : isGraderDigit(title, cand) ? "grader-digit"
        : isBarePrintRun(title, cand) ? "print-run-bare"
          : isYearNumber(title, cand) ? "year"
            : isOrdinal(title, cand) ? "ordinal"
              : isLotCount(title, cand) ? "lot-count"
                : null;

  if (rejected) return { cardNumber: null, rejected, titleNumber: null, vendorDisagrees: false, source: "none" };
  return { cardNumber: cand, rejected: null, titleNumber: null, vendorDisagrees: false, source: "candidate" };
}

// ── the one side effect ──────────────────────────────────────────────────────
// Everything above is pure. This is the counter: App Insights reads the JSON
// lines console.log emits (the same shape as sub_raw_inversion_observed), and
// `card_number_integrity` in the nightly cleanliness check reads the rows.
// It lives here so five emitters cannot spell the event five ways.

/** Emit `card_number_vendor_disagrees` when the title's `#X` overrode a vendor
 *  field, and `card_number_refused` when a candidate was thrown away. Both are
 *  no-ops when the verdict kept the candidate. Never throws. */
export function logCardNumberVerdict(
  emitter: string,
  verdict: CardNumberVerdict,
  ctx: { candidate?: string | null; title?: string | null; cardId?: string | null } = {},
): void {
  try {
    if (!verdict.vendorDisagrees && !verdict.rejected) return;
    console.log(JSON.stringify({
      event: verdict.vendorDisagrees ? "card_number_vendor_disagrees" : "card_number_refused",
      emitter,
      vendorCardNumber: ctx.candidate ?? null,
      titleCardNumber: verdict.titleNumber,
      kept: verdict.cardNumber,
      rejected: verdict.rejected,
      cardId: ctx.cardId ?? null,
      title: String(ctx.title ?? "").slice(0, 160) || null,
      timestamp: new Date().toISOString(),
    }));
  } catch { /* telemetry must never break an ingest */ }
}
