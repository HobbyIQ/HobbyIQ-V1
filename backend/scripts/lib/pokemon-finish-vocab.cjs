"use strict";
/**
 * CF-A-FINISH-IS-A-CARD-LINE (Drew, 2026-09-07) -- THE VOCABULARY.
 *
 * Lifted out of `mint-attested-finish-rows.cjs` so the ruling can be PINNED BY
 * TEST without importing the lane (whose body is an IIFE that runs on import,
 * as every runner lane in this directory is). One list decides the question;
 * the lane and the test read the same one, which is the reason
 * `statedFinishFromChecklist` records for its own mirror.
 *
 * WHAT A FINISH IS. How the card is PRINTED -- Holofoil, Reverse Holofoil,
 * Normal, and the era equivalents ("Cosmos Holo", "Cracked Ice"). Each is a
 * distinct card line with its own catalog row and its own pool.
 *
 * WHAT A FINISH IS NOT, and why each is deliberately absent:
 *   1st-edition, shadowless, unlimited   a SEPARATE AXIS (print state). The
 *                                        ruling says so outright.
 *   full-art, illustration-rare,         a card TYPE / rarity.
 *   double-rare, secret-rare
 *   master-ball, poke-ball, stamped      a STAMP applied to a card.
 *   gamestop, toys-r-us, pokemon-center  a DISTRIBUTION channel.
 * All of those are real distinctions and several are real card lines. They are
 * simply not FINISHES, and this ruling is about finishes. Adding a token here
 * MINTS CATALOG ROWS, so it is a vocabulary decision: measure the census first.
 */

/**
 * Market spelling -> canonical finish token.
 *
 * SEVERAL SPELLINGS REACH ONE CARD LINE, which is the point. The whole-pool
 * census of 2026-09-06 (3,262,614 Pokemon sold_comps rows) found ONE physical
 * finish split three ways --
 *
 *     215,231  reverse-holo
 *      71,094  reverse-foil
 *      12,712  reverse
 *
 * -- three pools for one card, which is exactly what CF-ONE-CARD-ONE-ROW-ONE-POOL
 * forbids. The holo family was split too: 3,915 `holofoil` against 280 `holo`.
 *
 * REVERSE IS NEVER FOLDED ONTO HOLO. A Reverse Holofoil and a Holofoil are
 * different cards at different prices. Every `reverse-*` key maps to a
 * `reverse-*` value and to nothing else; `finishFamiliesStayApart` pins it.
 */
const FINISH_TOKENS = Object.freeze({
  // The holo family.
  "holofoil": "holofoil",
  "holofoils": "holofoil",
  "holo": "holofoil",
  "holos": "holofoil",
  "holo-rare": "holofoil",
  "foil": "holofoil",
  "foils": "holofoil",
  // The reverse family. NEVER folds onto the holo family above.
  "reverse-holofoil": "reverse-holofoil",
  "reverse-holofoils": "reverse-holofoil",
  "reverse-holo": "reverse-holofoil",
  "reverse-holos": "reverse-holofoil",
  "reverse-foil": "reverse-holofoil",
  "reverse-foils": "reverse-holofoil",
  "reverse": "reverse-holofoil",
  // Era-specific finishes, each its own line.
  "cosmos-holo": "cosmos-holo",
  "cosmos": "cosmos-holo",
  "cracked-ice": "cracked-ice",
  "cracked-ice-holo": "cracked-ice",
  "cracked-ice-holofoil": "cracked-ice",
  // The un-foiled line. "Normal" is TCGplayer's own word for it.
  "normal": "normal",
});

/**
 * Canonical token -> the DISPLAY name written into the row's `parallel` field.
 *
 * Each one must be a `normalizeParallel` FIXED POINT THROUGH ITS TOKEN: the
 * display name has to slug back to exactly the token, or the row would be
 * minted at one address and looked up at another (the multi-home defect).
 * `finishDisplayNamesAreFixedPoints` pins it against the live slug builder.
 */
const FINISH_DISPLAY = Object.freeze({
  "holofoil": "Holofoil",
  "reverse-holofoil": "Reverse Holofoil",
  "cosmos-holo": "Cosmos Holo",
  "cracked-ice": "Cracked Ice",
  "normal": "Normal",
});

/** The canonical finish a parallel SEGMENT names, or null when the segment
 *  names something that is not a finish at all. */
function finishOf(parallelSegment) {
  const key = String(parallelSegment ?? "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(FINISH_TOKENS, key) ? FINISH_TOKENS[key] : null;
}

/** The market a TITLE states, or null when it states neither. Deliberately
 *  narrow: only an explicit word is evidence, because the guard that reads it
 *  refuses a mint. */
const JA_TITLE = /\b(japanese|japan|jpn|jp)\b/i;
const EN_TITLE = /\b(english|eng)\b/i;
function titleMarket(title) {
  const t = String(title ?? "");
  if (JA_TITLE.test(t)) return "ja";
  if (EN_TITLE.test(t)) return "en";
  return null;
}

module.exports = { FINISH_TOKENS, FINISH_DISPLAY, finishOf, titleMarket };
