/**
 * CF-A-NOTE-IS-NOT-A-RUNG (Drew, 2026-09-25).
 *
 * Tonight's census: 251,043 checklist-grade card_catalog rows (2024-2026
 * Topps/Bowman) carry a channel word, an inline print-run count, "exclusive",
 * pack odds, SKU text or a stray parenthetical GLUED into `parallel` --
 *
 *   "Purple Tinsel (Meijer exclusive)"
 *   "Silver Crackle Foil (Super Box exclusive)"
 *   "Crackle Foil: 10,400 copies"
 *   "Gold Wave 1:38 packs"
 *   "Platinum2999"                       (a run-on-digit corruption)
 *
 * DOCTRINE (memory: no-medians / stated-rungs-verbatim):
 *   - a stated rung is copied VERBATIM, never invented, never trimmed to a
 *     guess -- but "verbatim" means the checklist's RUNG NAME, not every
 *     byte a scraper glued beside it;
 *   - print run lives in `printRun`, never folded into the name string;
 *   - notes / odds / channel words never enter the name;
 *   - blank means unknown, never "Base".
 *
 * clean-parallel-annotations.cjs (2026-08-29) already REPAIRS this shape on
 * rows already sitting in Cosmos. This module is the same judgment applied
 * at INGEST TIME, before a row is ever written -- the ingester REFUSES a
 * dirty name rather than writing it and hoping a later repair pass finds it.
 * Refusal, not rewrite: a human must verify the suggested clean name against
 * the checklist before it becomes the stored value, so this module only
 * classifies and suggests -- it never mutates a row itself.
 *
 * Exported: `rungNameHygiene(parallel)` ->
 *   { clean: true }
 *   { clean: false, kind, suggestedName, suggestedPrintRun? }
 *
 * `kind` is one of:
 *   "channel"        Hobby / Retail / Blaster / Super Box / Mega Box / a
 *                     named-retailer exclusive glued into the name
 *   "print-run"       an inline print-run count ("Crackle Foil: 10,400
 *                     copies", "8700 copies", "/50 copies")
 *   "exclusive"       the bare word "exclusive" outside a channel phrase
 *   "odds"            pack odds ("1:38 packs", "1:24 hobby")
 *   "sku"             a SKU / product-code fragment
 *   "parenthetical"   a stray "(...)" that is not itself a known-good rung
 *                     grammar (X-Fractor, 1/1, etc.)
 *   "run-on-digits"   a rung word glued directly to a digit run with no
 *                     separator ("Platinum2999")
 *
 * NEGATIVE CASES (must classify clean -- see the unit tests):
 *   "1989 Topps Design", "Gold /50" (run in its own column), "X-Fractor",
 *   "Base Autograph", "1/1", "Refractor", "Purple Ice", "Wave", "Chrome
 *   Sepia", "Independence Day", "Clear Cut".
 *
 * CF-A-CHANNEL-WORD-CAN-BE-THE-WHOLE-STATED-NAME (found scanning committed
 * packages, 2026-09-25). "Hobby Exclusive" and "Fanatics Fest Exclusive"
 * standing ALONE, as the row's ENTIRE parallel value, are themselves real
 * printed Topps/Bowman parallel names -- Beckett's own S3 checklist lists
 * 2026 Topps Series 2 #352 as "Hobby Exclusive", not as some other rung with
 * a note glued on. Likewise "Base Prospect Retail Autographs" is Bowman's
 * own category name for a real insert (`auto-base-prospect-retail-
 * autographs`), and "Hobby Masters" is a named 2003 Topps insert set -- in
 * both, the channel word IS PART OF the stated name, not a note appended to
 * a different one.
 *
 * The census's own examples are never a BARE channel phrase: every one is a
 * channel/retailer NOTE set off in PARENTHESES beside an unrelated colour/
 * finish rung -- "Purple Tinsel (Meijer exclusive)", "Silver Crackle Foil
 * (Super Box exclusive)". That parenthetical form is the reliable signal:
 * it is how a scraper visibly glues a footnote onto a name, and it is what
 * clean-parallel-annotations.cjs's own `clean()` targets on the repair side.
 * A BARE channel/exclusive word or phrase, with nothing in parentheses, is
 * never flagged by CHANNEL_RE/BARE_EXCLUSIVE_RE alone -- "Hobby Exclusive",
 * "Fanatics Fest Exclusive", "Base Prospect Retail Autographs" and "Hobby
 * Masters" are all real printed names on committed packages, and pattern-
 * matching a bare channel word out of them would invent a split no checklist
 * page states, exactly the failure stated-rungs-verbatim exists to prevent
 * in the OTHER direction. Only the parenthetical shape is refused.
 */
"use strict";

/** Channel / retailer words that are never part of a stated rung name WHEN
 *  they appear as a parenthetical note (see CF-A-CHANNEL-WORD-CAN-BE-THE-
 *  WHOLE-STATED-NAME above for why a BARE occurrence is never enough on its
 *  own). */
const CHANNEL_WORDS = [
  "hobby", "retail", "blaster", "mega box", "super box", "hanger",
  "fat pack", "jumbo pack", "value pack", "target exclusive", "walmart exclusive",
  "meijer exclusive", "walgreens exclusive", "fanatics exclusive", "hobby exclusive",
  "retail exclusive", "hobby box", "retail box", "hobby only", "retail only",
  "asia exclusive", "japan exclusive",
];
const CHANNEL_RE = new RegExp(`\\b(?:${CHANNEL_WORDS.map((w) => w.replace(/\s+/g, "\\s+")).join("|")})\\b`, "i");

/** Every parenthetical group in the string, contents captured. */
const ANY_PAREN_RE = /\(([^()]*)\)/g;

/** Pack odds: "1:38 packs", "1:24 Hobby", "1 in 38". */
const ODDS_RE = /\b\d{1,4}\s*(?::|in)\s*\d{1,5}\s*(?:packs?|boxes?|cases?|hobby|retail)?\b/i;

/** Inline print-run counts glued into the name: "10,400 copies",
 *  "8700 copies", ": 10,400 copies", "/50 copies", "numbered to 500". A bare
 *  "/50" with NOTHING else around it is the standard numbered-parallel
 *  grammar ("Gold /50") and is handled separately as clean when it is the
 *  row's entire trailing token -- this regex requires the word "copies"/
 *  "made"/"cards" or an explicit "numbered to" so it never fires on that
 *  shape. */
const PRINT_RUN_WORDS_RE = /(\d[\d,]{0,6})\s*(?:copies|cards made|cards|made)\b/i;
const NUMBERED_TO_RE = /numbered\s+to\s*(\d[\d,]{0,6})/i;
const COLON_PRINT_RUN_RE = /:\s*(\d[\d,]{0,6})\s*copies\b/i;

/** The bare word "exclusive" outside a recognised channel phrase --
 *  "Purple Exclusive" with no retailer named. Still not a stated rung name:
 *  "exclusive" describes DISTRIBUTION, not the card. */
const BARE_EXCLUSIVE_RE = /\bexclusive\b/i;

/** SKU-shaped fragments: a run of letters+digits that looks like a product
 *  code rather than a rung word -- "SKU 84356", "UPC 887521004433", or a
 *  bare 8+ digit run with no rung vocabulary around it. */
const SKU_RE = /\b(?:SKU|UPC|ITEM\s*#?)\s*[:#]?\s*[A-Z0-9-]{4,}\b/i;
const LONG_DIGIT_RUN_RE = /\b\d{6,}\b/;

/** Known-good grammar that must NEVER be misread as a dirty parenthetical or
 *  a run-on-digit corruption. Checked FIRST, before any dirty-shape test, so
 *  a legitimate rung can never be caught by a broader pattern below it. */
const KNOWN_GOOD_RE = [
  /^\d{4}\s+[A-Za-z]/,                 // "1989 Topps Design" -- a year-lead insert name
  /^[A-Za-z][\w'.-]*\s*\/\s*\d{1,6}$/, // "Gold /50" -- numbered parallel, run in its own column
  /^\d{1,3}\s*\/\s*\d{1,6}$/,          // "1/1"
  /^[A-Za-z][\w'-]*-Fractor$/i,        // "X-Fractor"
  /^(?:Base\s+)?Autograph[s]?$/i,      // "Base Autograph" / "Autographs"
  // CF-IMAGE-VARIATIONS-ARE-NAMED-CARDS (memory: "<Name> Image Variation
  // SP"). Beckett's own descriptor for a specific image variation legitimately
  // carries a parenthetical, e.g. "Throwing (gold Refractor) Image Variation
  // SP" -- the parenthetical IS part of the stated name here, not a leaked
  // channel/print-run note glued on after the fact.
  /\bImage Variation\b/i,
];

/** Rung vocabulary a run-on-digit corruption glues a number onto with NO
 *  separator: "Platinum2999", "Gold500", "Wave25". Requires the word to be
 *  the WHOLE prefix (case-insensitive) and the digits to fill out the rest
 *  of the token, so a legitimately alphanumeric insert name is not caught. */
const RUNG_WORD_DIGIT_GLUE_RE = /^(?:[A-Za-z][A-Za-z]{2,})(\d{2,6})$/;
const KNOWN_RUNG_PREFIXES = new Set([
  "platinum", "gold", "silver", "bronze", "wave", "mojo", "prizm", "chrome",
  "refractor", "shimmer", "foil", "holo", "rainbow", "atomic", "lava",
]);

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Classify a checklist `parallel` string. Pure, no I/O. Returns
 * `{ clean: true }` for a stated rung name with nothing riding on it, or
 * `{ clean: false, kind, suggestedName, suggestedPrintRun? }` naming the
 * leaked text and a HUMAN-REVIEWABLE suggestion -- never auto-applied by
 * the caller.
 */
function rungNameHygiene(parallel) {
  const raw = String(parallel ?? "").trim();
  if (!raw) return { clean: true };

  // Known-good grammar wins outright, before any dirty-shape test runs.
  for (const re of KNOWN_GOOD_RE) if (re.test(raw)) return { clean: true };

  // 1. CHANNEL: a channel/retailer phrase set off in PARENTHESES beside a
  //    rung name -- "Purple Tinsel (Meijer exclusive)", "Silver Crackle Foil
  //    (Super Box exclusive)". Requires BOTH the parens AND channel
  //    vocabulary inside them, and requires text OUTSIDE the parens too (a
  //    bare "(Hobby Exclusive)" with nothing else is still ambiguous with a
  //    real printed name and falls through to the generic parenthetical
  //    gate below, which still refuses it -- just under `kind: "channel"`
  //    specifically only when there is a name for the note to be glued onto).
  {
    const parens = [...raw.matchAll(ANY_PAREN_RE)];
    const channelParen = parens.find(([, inner]) => CHANNEL_RE.test(inner));
    if (channelParen) {
      const cleaned = raw
        .replace(ANY_PAREN_RE, (m, inner) => (CHANNEL_RE.test(inner) ? "" : m))
        .replace(/[-–—:]\s*$/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      return { clean: false, kind: "channel", suggestedName: cleaned || null };
    }
  }

  // 2. PRINT-RUN: an inline count glued into the name.
  {
    const m = raw.match(COLON_PRINT_RUN_RE) || raw.match(PRINT_RUN_WORDS_RE) || raw.match(NUMBERED_TO_RE);
    if (m) {
      const suggestedPrintRun = Number(m[1].replace(/,/g, "")) || null;
      const suggestedName = raw
        .replace(COLON_PRINT_RUN_RE, "")
        .replace(PRINT_RUN_WORDS_RE, "")
        .replace(NUMBERED_TO_RE, "")
        .replace(/[-–—:]\s*$/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      return { clean: false, kind: "print-run", suggestedName: suggestedName || null, suggestedPrintRun };
    }
  }

  // 3. ODDS: pack odds glued into the name.
  if (ODDS_RE.test(raw)) {
    const suggestedName = raw.replace(ODDS_RE, "").replace(/\s{2,}/g, " ").trim();
    return { clean: false, kind: "odds", suggestedName: suggestedName || null };
  }

  // 4. SKU: a product-code fragment.
  if (SKU_RE.test(raw) || LONG_DIGIT_RUN_RE.test(raw)) {
    const suggestedName = raw.replace(SKU_RE, "").replace(LONG_DIGIT_RUN_RE, "").replace(/\s{2,}/g, " ").trim();
    return { clean: false, kind: "sku", suggestedName: suggestedName || null };
  }

  // 5. EXCLUSIVE: the word "exclusive" set off in PARENTHESES beside a rung
  //    name -- "Teal (exclusive)", the same compound shape as CHANNEL above
  //    but without a named retailer/box-type word inside the parens. A BARE
  //    "Purple Exclusive" with no parentheses is left to the caller's own
  //    judgment: unlike the channel-phrase case, "exclusive" alone is not on
  //    any committed package's checklist as a standalone name, but nor does
  //    this module invent a split a scraper's own comma/column boundary
  //    does not show. Scoped to parens, matching every other kind here.
  {
    const parens = [...raw.matchAll(ANY_PAREN_RE)];
    const exclusiveParen = parens.find(([, inner]) => BARE_EXCLUSIVE_RE.test(inner));
    if (exclusiveParen) {
      const suggestedName = raw.replace(ANY_PAREN_RE, (m, inner) => (BARE_EXCLUSIVE_RE.test(inner) ? "" : m))
        .replace(/[-–—:]\s*$/, "").replace(/\s{2,}/g, " ").trim();
      return { clean: false, kind: "exclusive", suggestedName: suggestedName || null };
    }
  }

  // 6. PARENTHETICAL: any remaining "(...)" is a stray note once none of the
  //    above matched inside it -- a checklist rung name does not carry its
  //    own footnote in parens (the known-good list above already excused
  //    every legitimate parenthetical grammar this codebase uses).
  if (/\([^()]*\)/.test(raw)) {
    const suggestedName = raw.replace(/\s*\([^()]*\)\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    return { clean: false, kind: "parenthetical", suggestedName: suggestedName || null };
  }

  // 7. RUN-ON-DIGITS: a rung word glued directly to a digit run with no
  //    separator -- a scraper corruption ("Platinum2999"), not a stated name.
  {
    const folded = stripDiacritics(raw);
    const m = folded.match(RUNG_WORD_DIGIT_GLUE_RE);
    if (m) {
      const word = folded.slice(0, folded.length - m[1].length).toLowerCase();
      if (KNOWN_RUNG_PREFIXES.has(word)) {
        const suggestedName = raw.slice(0, raw.length - m[1].length).trim();
        return { clean: false, kind: "run-on-digits", suggestedName: suggestedName || null, suggestedPrintRun: Number(m[1]) || null };
      }
    }
  }

  return { clean: true };
}

module.exports = { rungNameHygiene, CHANNEL_WORDS };
