/**
 * CF-THE-SET-YEAR-IS-DERIVED-NOT-GUESSED (2026-09-08).
 *
 * The year half of the Pokemon address. `hiq:pokemon:<year>:<setKey>:<num>:
 * <finish>:no-auto` needs a cardYear, and a TCGplayer sale row does not carry
 * one -- `year` is NULL on every TCGplayer row TCA serves. The year belongs to
 * the SET, not the sale, so it is looked up from the set, and a set we cannot
 * name a year for is SKIPPED rather than dated by guess.
 *
 * WHERE THE YEARS COME FROM. Not a new hand-typed table -- from the alias table
 * that is already committed and already generated from tcgdex. 470 of
 * `POKEMON_SET_ALIASES`' keys are year-prefixed spellings ("1999-base-set",
 * "2025-mega-evolution"), because that is how sellers write them. Grouping
 * those aliases by the code they resolve to yields, for each set, the set of
 * years any seller spelling claims for it. Measured over all 218 English codes
 * on the committed table:
 *
 *   214 codes  exactly one year across every alias   -> that year is the set's
 *     0 codes  two or more DIFFERENT years            -> nothing to arbitrate
 *     4 codes  no year-prefixed alias at all          -> swsh9tg swsh10tg
 *                                                        swsh11tg swsh12tg
 *
 * Zero conflicts is the fact that makes this derivation safe rather than a
 * heuristic: there is no case where the corpus disagrees with itself about a
 * set's year, so there is no tie for this module to break and no judgement for
 * it to exercise. It reads what is already there.
 *
 * THE FOUR GAPS ARE THE TRAINER GALLERY SUBSETS, and they are resolved by
 * their PARENT, not by a guess: `swsh10tg` is the Trainer Gallery printed
 * inside `swsh10`, shares its release, and inherits its year (2022 for all
 * four). The `tg` suffix strip is the only structural fallback here, and it is
 * deliberately the only one -- a code whose parent is also unknown yields null
 * and its rows are counted, never dated.
 *
 * NO YEAR IS INVENTED. Every value traces to a committed, tcgdex-generated
 * alias spelling, in obedience to CF-NO-SYNTHETIC-PARALLELS-ONLY-ACTUALS.
 */

import { POKEMON_SET_ALIASES } from "./pokemonSetAliases.js";

/**
 * setKey (tcgdex code) -> release year, derived once at module load from the
 * year-prefixed spellings in POKEMON_SET_ALIASES.
 *
 * A code appears here ONLY when every year-prefixed alias naming it agrees.
 * A code whose aliases disagree is deliberately absent: an ambiguous year is
 * the same fact as no year, and both must reach the caller as "skip this row",
 * never as a coin flip between two addresses.
 */
export const POKEMON_SET_YEARS: Readonly<Record<string, number>> = Object.freeze(
  (() => {
    const seen = new Map<string, Set<number>>();
    for (const [alias, code] of Object.entries(POKEMON_SET_ALIASES)) {
      const m = /^((?:19|20)\d{2})-/.exec(alias);
      if (!m) continue;
      let years = seen.get(code);
      if (!years) { years = new Set<number>(); seen.set(code, years); }
      years.add(Number(m[1]));
    }
    const out: Record<string, number> = {};
    for (const [code, years] of seen) {
      // Exactly one year, or nothing. See the header: measured at 214/218 with
      // zero conflicts, so this branch drops nothing today -- it is here so
      // that a future regenerated table which DOES conflict degrades to a
      // counted skip instead of silently picking whichever year enumerated
      // first.
      if (years.size === 1) out[code] = [...years][0];
    }
    return out;
  })(),
);

/**
 * The release year for a Pokemon setKey, or null when the vocabulary cannot
 * name one.
 *
 * Null is a real answer and the caller must honour it: the row is counted as
 * `skippedSetUnmapped` and left unwritten. Dating a sale by guess files it at
 * an address no checklist row occupies, which is the split-pool failure
 * CF-ONE-CARD-ONE-ROW-ONE-POOL exists to prevent.
 */
export function pokemonSetYear(setKey: string | null | undefined): number | null {
  if (!setKey) return null;
  const key = String(setKey).toLowerCase();
  const direct = POKEMON_SET_YEARS[key];
  if (direct) return direct;
  // Trainer Gallery subsets inherit their parent set's release year -- they are
  // printed inside that set, not issued separately. Structural, not a guess.
  const parent = /^(.*)tg$/.exec(key);
  if (parent) {
    const py = POKEMON_SET_YEARS[parent[1]];
    if (py) return py;
  }
  return null;
}
