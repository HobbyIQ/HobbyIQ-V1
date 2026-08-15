// CF-SLUG-REFUSE-FALLBACKS (Drew, 2026-08-14). Validate slug inputs
// BEFORE computing a hobbyiqCardId, and refuse rather than emit a
// well-formed slug that means nothing.
//
// WHY THIS EXISTS
//
// computeHobbyIqCardId is deliberately total — it always returns a
// string. That is correct for a pure identity function, but it means
// garbage in produces confident garbage out, and the result is
// indistinguishable from a real slug downstream. Measured 2026-08-14,
// sampling distinct slugs per sport and probing card_catalog:
//
//     baseball 90.3%   pokemon 92.9%   football 75.6%
//     basketball 65.7%   hockey 14.8%
//
// Hockey looked like a catalog gap. It was not. `sport='hockey'` rows
// were dominated by setKey=bowman (10,234) and Pokemon's
// swsh09-brilliant-stars (503). Actual rows behind those slugs:
//
//     1981 | Reggie Jackson | set="bowman" | 1981 Kellogg's 3-D Super Stars Baseball #3
//     197  | Rich Gossage   | set="bowman" | 1978 Kellogg's 3-D Super Stars Baseball #8
//
// Three independent failures stacked into one slug: the sport is wrong,
// `bowman` is a caller-side default rather than a parse, and the year
// 197 is a truncated 1978. The slug hiq:hockey:197:bowman:8:base:no-auto
// is syntactically perfect and completely meaningless — and it pools a
// Kellogg's baseball card against hockey Bowman comps.
//
// DOCTRINE
//
// An ABSENT slug is strictly better than a WRONG one. A row with no
// hobbyiqCardId is visibly unkeyed and can be re-derived later from its
// title; a row with a wrong slug silently corrupts a comp pool and looks
// healthy. This is the same principle as the no-synthetic-parallels
// rule, applied one layer earlier: refuse to fabricate identity.
//
// SCOPE
//
// This module only REJECTS. It never invents a value. Callers that get a
// rejection should leave hobbyiqCardId null and let the re-derivation
// pass handle the row.

/** Sports we accept as a slug namespace. Anything outside this set is a
 *  vendor string we have not taught the system to read yet, and must not
 *  become the top-level namespace of an identifier. */
export const CANONICAL_SPORTS: ReadonlySet<string> = new Set([
  "baseball", "basketball", "football", "hockey", "soccer",
  "pokemon", "anime-tcg", "yugioh", "tcg-other",
  "non-sport", "tennis", "golf", "racing", "mma", "boxing",
  "wrestling", "multi-sport",
]);

/** Vendor spellings that map cleanly onto a canonical sport. Collapsing
 *  these is safe: both sides denote the same vertical. Anything NOT here
 *  and not already canonical is rejected rather than guessed. */
const SPORT_ALIASES: Readonly<Record<string, string>> = {
  // League abbreviations.
  nfl: "football", nba: "basketball", mlb: "baseball", nhl: "hockey",
  // Spelling / punctuation drift observed in sold_comps 2026-08-14.
  "ice-hockey": "hockey",
  "ice hockey": "hockey",
  "non-sports": "non-sport",
  "non sports": "non-sport",
  "non sport": "non-sport",
  "nonsport": "non-sport",
  "mixed-martial-arts-mma": "mma",
  "mixed martial arts (mma)": "mma",
  "mixed-martial-arts": "mma",
  ufc: "mma",
  "auto-racing": "racing",
  "auto racing": "racing",
  "motor-racing": "racing",
  "motor racing": "racing",
  nascar: "racing",
  "american-football": "football",
  calcio: "soccer",
  futbol: "soccer",
};

/**
 * Normalize a raw sport string to a canonical tag, or null when it
 * cannot be trusted as a namespace.
 *
 * Multi-value strings are REJECTED, never split. `"football, baseball"`
 * and `"basketball,collabs-eligible,single"` are vendor tag dumps, not
 * sports — picking the first token would silently assign a namespace on
 * a coin flip.
 */
export function normalizeSportStrict(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;

  // Multi-value tag dumps: a comma, a slash, or an " and " join.
  if (/[,/]/.test(trimmed) || /\sand\s/.test(trimmed)) return null;

  const direct = SPORT_ALIASES[trimmed];
  if (direct) return direct;

  const hyphenated = trimmed.replace(/\s+/g, "-");
  const viaHyphen = SPORT_ALIASES[hyphenated];
  if (viaHyphen) return viaHyphen;

  if (CANONICAL_SPORTS.has(trimmed)) return trimmed;
  if (CANONICAL_SPORTS.has(hyphenated)) return hyphenated;

  // Compound junk like "basketball-football" or "basketball-basketball"
  // reaches here and is correctly rejected.
  return null;
}

/** Cards predate 1900 only in edge cases we do not carry; a year beyond
 *  next season is a parse artifact. Rejects 197 (truncated 1978), 0, and
 *  NaN — all present in the pool today. */
export function isValidCardYear(year: unknown, nowYear: number = new Date().getUTCFullYear()): boolean {
  if (typeof year !== "number" || !Number.isFinite(year)) return false;
  if (!Number.isInteger(year)) return false;
  return year >= 1900 && year <= nowYear + 2;
}

/**
 * Detect a setKey that is really an unnormalized vendor product string.
 *
 * normalizeSetKey() falls back to slugify() when no controlled-vocabulary
 * pattern matches, which mints setKeys like `2018-panini-majestic-football`
 * and `1992-classic-draft-picks-baseball`. Those can never match a catalog
 * keyed on `panini-majestic`, so the slug is dead on arrival.
 *
 * Two signatures, both chosen because no legitimate canonical setKey has
 * them:
 *   - leading 4-digit year   (`2021-panini-impeccable-football`)
 *   - trailing sport word    (`...-baseball`, `...-football`)
 *
 * Deliberately NOT rejecting "absent from the controlled vocabulary" —
 * legitimate sets live outside it (Pokemon's `swsh09-brilliant-stars`
 * resolves at 92.9%). Only these two shapes are treated as junk.
 */
export function isRawVendorSetKey(setKey: string | null | undefined): boolean {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return false;
  if (/^(19|20)\d{2}-/.test(s)) return true;
  if (/-(baseball|basketball|football|hockey|soccer)$/.test(s)) return true;
  return false;
}

export type SlugRejectReason =
  | "sport-uncanonical"
  | "year-invalid"
  | "setkey-raw-vendor-string"
  | "setkey-missing"
  | "cardnumber-missing";

export interface SlugGuardResult {
  ok: boolean;
  /** Canonical sport when ok; null otherwise. */
  sport: string | null;
  reasons: SlugRejectReason[];
}

/**
 * Gate the inputs to computeHobbyIqCardId.
 *
 * Returns every failing reason rather than the first, so telemetry can
 * show which defect dominates instead of whichever check happens to run
 * first.
 *
 * `setKey` here is the NORMALIZED key (post normalizeSetKey), because
 * the raw-vendor-string signature is only visible after slugification.
 */
export function guardSlugInputs(input: {
  sport: string | null | undefined;
  year: unknown;
  normalizedSetKey: string | null | undefined;
  cardNumber: string | null | undefined;
}): SlugGuardResult {
  const reasons: SlugRejectReason[] = [];

  const sport = normalizeSportStrict(input.sport);
  if (!sport) reasons.push("sport-uncanonical");

  if (!isValidCardYear(input.year)) reasons.push("year-invalid");

  const setKey = String(input.normalizedSetKey ?? "").trim();
  if (!setKey) reasons.push("setkey-missing");
  else if (isRawVendorSetKey(setKey)) reasons.push("setkey-raw-vendor-string");

  const cardNumber = String(input.cardNumber ?? "").trim().toLowerCase();
  if (!cardNumber || cardNumber === "null" || cardNumber === "undefined") {
    reasons.push("cardnumber-missing");
  }

  return { ok: reasons.length === 0, sport: reasons.length === 0 ? sport : null, reasons };
}
