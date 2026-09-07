"use strict";
/**
 * CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (Drew, 2026-09-07, R5), the
 * INGEST side of the ruling #1959 landed on the resolver side.
 *
 * #1959 gave the 38 Japanese sets that share an English set code a distinct
 * address -- `ja-<code>`: `jungle` -> `ja-base2`, `SM10` -> `ja-sm10`. It also
 * stated the cost, and named the mechanism that caused it:
 *
 *   "the code-table generator drops a Japanese set whose id an English set
 *    already holds -- `if (enByCode.has(code)) continue` -- which is why
 *    POKEMON_JA_SET_CODES has 160 entries and not 184."
 *
 * The two tcgdex STAGING lanes carry the same exclusion in their own spelling,
 * `ja.filter((s) => !enIds.has(s.id))`, and this module is what ends it. A JA
 * set that shares an English code is no longer dropped; it is staged under the
 * ruled `ja-<code>` key, which is the address #1959 created for exactly it.
 *
 * -- THE DEFECT IS CASE, AND IT CUTS BOTH WAYS -------------------------------
 *
 * The lanes compare tcgdex ids EXACTLY, and tcgdex does not spell the two
 * markets' ids the same way. Measured live 2026-09-07 against
 * api.tcgdex.net/v2 (218 EN sets, 184 JA):
 *
 *   EN ids are lowercase           `sm10`, `xy7`, `sv10`, `neo1`
 *   JA ids are mostly UPPERCASE    `SM10`, `XY7`, `SV10` -- but `neo1` is not
 *
 * So `!enIds.has(s.id)` produces TWO different wrong answers over one scope:
 *
 *   neo1..neo4   lowercase in BOTH markets -> the filter matches -> DROPPED.
 *                4 sets, 323 cards, never staged. This is the miss #1959
 *                predicted.
 *
 *   SM6..SM12,   uppercase in JA only -> the filter does NOT match -> KEPT,
 *   XY2..XY10,   and then staged under `setKey = s.id.toLowerCase()`, which is
 *   SV10         the ENGLISH key. This is worse than a drop: it mints Japanese
 *                cards onto the English product's address, the precise
 *                one-card-one-row defect #1959 spent 32,342 rows repairing.
 *                It is not hypothetical -- the 42 catalog rows #1959 found
 *                mis-slugged at `sv10` ("Japanese ロケット団の栄光" on the
 *                English Destined Rivals key) are this line's output.
 *
 * Both answers are wrong for the same reason -- the market of a set is not a
 * property of how its id happens to be capitalised -- so both are fixed by one
 * rule: compare CASE-FOLDED, and let the ruling decide the key.
 *
 * -- WHAT THIS DOES NOT DO ---------------------------------------------------
 *
 * It does not widen the lanes' scope to every shared code. A JA set that has a
 * bare Japanese code of its own (`s12a`, `sv8a`) is untouched: the doctrine is
 * "JA = bare JA code WHERE ONE EXISTS", and those sets never enter the ruling's
 * map by construction. This module only answers for the codes #1959 ruled.
 *
 * It invents no cards. A shared-code set is staged from the SAME tcgdex
 * per-card read every other set uses; only its address changes.
 */

/** The slugify the generator and the services share. tcgdex writes `sv08.5`;
 *  every key in the catalog is `sv08-5`. Case-folding is the whole point. */
function slugCode(id) {
  return String(id ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The prefix a ruled Japanese vintage key carries. Mirrors JA_KEY_PREFIX in
 *  src/services/catalog/japaneseVintageSetKeyRuling.ts. */
const JA_KEY_PREFIX = "ja-";

/**
 * The setKey a Japanese tcgdex set stages under, given the English id set.
 *
 * `jaId`   the tcgdex JA set id, in the source's own capitalisation
 * `enIds`  every tcgdex EN set id (any iterable; compared case-folded)
 *
 * Returns the bare code when no English set owns it -- unchanged behaviour for
 * the 160 Japanese-only sets -- and the ruled `ja-<code>` when one does.
 */
function jaSetKeyFor(jaId, enIds) {
  const code = slugCode(jaId);
  if (!code) return null;
  const enCodes = enIds instanceof Set && enIds.has(code)
    ? enIds
    : new Set([...enIds].map(slugCode));
  return enCodes.has(code) ? `${JA_KEY_PREFIX}${code}` : code;
}

/** Does an English set own this JA set's code? The question the lanes used to
 *  answer with `enIds.has(s.id)` -- exact-case, and therefore wrong. */
function sharesEnglishCode(jaId, enIds) {
  const code = slugCode(jaId);
  if (!code) return false;
  for (const e of enIds) if (slugCode(e) === code) return true;
  return false;
}

module.exports = { slugCode, jaSetKeyFor, sharesEnglishCode, JA_KEY_PREFIX };
