/**
 * CF-THE-ENGLISH-SET-CODE-IS-THE-KEY (Drew, 2026-09-06).
 *
 * THE RULING. For an English Pokemon product the canonical setKey is the
 * tcgdex set CODE — `sv08-5` for Prismatic Evolutions, `base1` for Base Set,
 * `swsh12-5` for Crown Zenith. The normalized English NAME
 * (`prismatic-evolutions`, `pokemon-scarlet-violet-prismatic-evolutions`,
 * `base-set`) becomes an ALIAS of that code. It is the English half of
 * CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01), which ruled the same
 * way for the bare Japanese codes `sv2a` / `sv8a` / `s12a`, and it obeys the
 * same standing doctrine: A RULED KEY MUST BE A normalizeSetKey FIXED POINT.
 *
 * THE DEFECT IT ENDS, measured on this branch before the fix:
 *
 *   ONE PRODUCT, TWO SPELLINGS, BOTH FIXED POINTS. Of the 1,497 aliases in
 *   pokemonSetAliases.ts, 832 keys survived `normalizeSetKey` UNCHANGED. The
 *   name-keyed and code-keyed halves of the pool could each name themselves
 *   and neither could name the other:
 *
 *     the vendor path   resolveSetKeyForSlug -> POKEMON_SET_ALIASES -> sv08-5
 *     the title path    inferSetKeyFromTitle -> sv08-5
 *     normalizeSetKey("prismatic-evolutions") -> prismatic-evolutions   <-- split
 *
 *   `normalizeSetKey` — the function every stored key is re-derived through,
 *   and the one the slug guard and the Great Rematch both ask — had NO Pokemon
 *   vocabulary at all. The alias table existed and three other call sites
 *   already read it; this one never did. One card, two rows, a split pool, a
 *   wrong FMV (CF-ONE-CARD-ONE-ROW-ONE-POOL).
 *
 *   AND 35 OF THOSE NAMES WERE NOT MERELY SPLIT — THEY WERE WRONG. The sports
 *   vocabulary's unanchored brand patterns claimed them outright, filing
 *   Pokemon sales into Panini and Leaf pools:
 *
 *     obsidian-flames  -> panini-obsidian   (should be sv03)
 *     crown-zenith     -> panini-zenith     (should be swsh12-5)
 *     ancient-origins  -> panini-origins    (should be xy7)
 *     firered-leafgreen-> leaf              (should be ex6)
 *
 *   This is CF-NO-CROSS-VERTICAL-FALLBACK, which `resolveSetKeyForSlug`
 *   already states and enforces on its own branch, reaching the one deriver
 *   that had been left outside it.
 *
 * NO NEW DATA IS INVENTED HERE. Every pair comes from the committed,
 * tcgdex-generated tables (pokemonSetAliases.ts, 2026-08-16; pokemonSetCodes.ts,
 * 2026-09-05; api.tcgdex.net, MIT). This module only decides which of them
 * `normalizeSetKey` is allowed to act on, and it REFUSES three classes:
 *
 *  1. A KEY A STANDING RULING ALREADY OWNS. `ultra-prism` is `final` in
 *     setKeyReconciliation — a verdict taken against the real catalog. A
 *     ruling decided by measurement is not re-litigated by a table load, so
 *     the reconciliation is consulted at build time and its keys are dropped.
 *     (It is also consulted again at RUNTIME, ahead of this map, by
 *     normalizeSetKey's existing line order — this is belt and braces.)
 *
 *  2. A CODE, WHICH MUST STAY ITSELF. An alias whose key IS a set code is
 *     dropped so no code can ever be rewritten to another code. All 205
 *     English codes were already fixed points before this change and all 205
 *     remain fixed points after it — pinned by test.
 *
 *  3. A KEY THAT IS ALREADY THE ANSWER. Where the alias key normalizes to its
 *     own code today, there is nothing to rule.
 *
 * THE JAPANESE RULINGS ARE UNTOUCHED, and six shared spellings prove the
 * boundary has to be drawn on purpose. `base-set`, `black-bolt`,
 * `shining-legends` and `white-flare` name DIFFERENT products in the two
 * markets (EN `sv10-5b` vs JA `sv11b` for Black Bolt). A bare key handed to
 * `normalizeSetKey` carries no language, so it is read as ENGLISH — which is
 * what an English-market catalog key means — and the Japanese product is
 * reached the way it always was: `resolveSetKeyForSlug` tests the setName for
 * "japanese" and answers from JAPANESE_POKEMON_SET_ALIASES BEFORE
 * normalizeSetKey is ever called. That order is pinned by test, and so is the
 * ruled-JA-code map (`japanese-sv2a` -> `sv2a`, `swsh12a` -> `s12a`), which
 * `normalizeSetKey` still decides ahead of this one.
 */
import { POKEMON_SET_ALIASES } from "./pokemonSetAliases.js";
import { POKEMON_EN_SET_CODES, POKEMON_JA_SET_CODES, POKEMON_PROMO_SET_CODES } from "./pokemonSetCodes.js";
import { reconcileSetKey } from "./setKeyReconciliation.js";

/** Every code that must survive as itself: the English sets, the English
 *  promos, and the Japanese-only codes (which this map may never emit). */
function isASetCode(key: string): boolean {
  return Boolean(
    POKEMON_EN_SET_CODES[key] || POKEMON_PROMO_SET_CODES[key] || POKEMON_JA_SET_CODES[key],
  );
}

/**
 * The leading year, removed — because `normalizeSetKey` has ALREADY removed it
 * by the time it asks this map.
 *
 * 470 of the alias table's keys are year-prefixed (`2014-xy`,
 * `2023-pokemon-obsidian-flames`), and a map keyed by those spellings could
 * never be hit: `stripYearAndSport` runs at the top of `normalizeSetKey`, so
 * the key it looks up is always the bare form. Stripping the same prefix here
 * is what makes the two agree BY CONSTRUCTION rather than by keeping two
 * spellings in sync by hand — the same reasoning `matchKnownProductLine` gives
 * for consulting the product table instead of its own regexes.
 *
 * Deliberately a COPY of the year pattern rather than an import of
 * `stripYearAndSport`: hobbyIqCardId.service imports THIS module, so importing
 * it back would close a cycle. The sport suffix is not stripped — no Pokemon
 * alias carries one, and this map must not answer for a key it was not given.
 */
const YEAR_PREFIX = /^(?:19|20)\d{2}(?:-\d{2})?-/;

function bareKey(key: string): string {
  return key.replace(YEAR_PREFIX, "") || key;
}

/**
 * The ruled name -> code rewrites, built once from the committed tables.
 *
 * EXACT-TOKEN BY CONSTRUCTION, exactly like RULED_SET_KEY_REWRITES. These are
 * whole-key decisions consulted with `===`; nothing here is a prefix, a
 * substring or a pattern. That is what keeps `base-set` from touching
 * `base-set-2` and `sv08` from swallowing `sv08-5`.
 */
function build(): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null);
  // A spelling two DIFFERENT sets both answer to says nothing about which card
  // the sale is, so it is dropped rather than decided by iteration order. One
  // exists today: `crown-zenith` and `crown-zenith-galarian-gallery` are
  // distinct products (swsh12-5 and swsh12-5gg) whose year-prefixed spellings
  // are distinct too — the bare forms do NOT collide — but a future table
  // could introduce one, and a silent last-write-wins is exactly the
  // "confident wrong key" CF-UNKNOWN-IS-ALSO-A-GUESS forbids.
  const ambiguous = new Set<string>();
  const firstSeen = new Map<string, string>();
  for (const [alias, code] of Object.entries(POKEMON_SET_ALIASES)) {
    const key = bareKey(String(alias).toLowerCase());
    const target = String(code).toLowerCase();
    if (!key || !target || key === target) continue;
    const seen = firstSeen.get(key);
    if (seen === undefined) firstSeen.set(key, target);
    else if (seen !== target) ambiguous.add(key);
  }
  for (const [alias, code] of Object.entries(POKEMON_SET_ALIASES)) {
    const key = bareKey(String(alias).toLowerCase());
    const target = String(code).toLowerCase();
    if (!key || !target || key === target) continue;
    if (ambiguous.has(key)) continue;
    // (2) a code stays itself — never rewrite one code onto another.
    if (isASetCode(key)) continue;
    // The target must be an ENGLISH destination. The four Trainer Gallery
    // subsets (swsh9-5tg …) postdate the code-table snapshot and are English
    // by construction — they appear in no Japanese table — so a target absent
    // from every code table is accepted, while one present in the JAPANESE
    // table is refused: this map is the ENGLISH ruling and must not be a back
    // door into the Japanese vocabulary.
    if (POKEMON_JA_SET_CODES[target] && !POKEMON_EN_SET_CODES[target]) continue;
    // (1) a standing ruling wins. Measured, not assumed.
    if (reconcileSetKey(key).final) continue;
    out[key] = target;
  }
  return Object.freeze(out);
}

let cached: Readonly<Record<string, string>> | null = null;

/** The ruled English-name -> set-code rewrites. Lazy so the reconciliation
 *  file is read on first use, never at import time (CF-RECONCILIATION-
 *  DEFENSIVE-LOAD: a module every minted id imports must not do I/O to be
 *  imported). */
export function pokemonEnglishSetKeyRewrites(): Readonly<Record<string, string>> {
  if (!cached) cached = build();
  return cached;
}

/**
 * The ruled English code for a setKey spelling, or null.
 *
 * Takes a key that has ALREADY been slugified and stripped of its year and
 * sport — the shape `normalizeSetKey` holds at the point it asks.
 */
export function ruledPokemonEnglishSetKey(setKey: string): string | null {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return null;
  return pokemonEnglishSetKeyRewrites()[s] ?? null;
}
