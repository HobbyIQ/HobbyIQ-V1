/**
 * CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (Drew, 2026-09-07, R5).
 *
 * THE RULING. The 38 Japanese sets whose alias in JAPANESE_POKEMON_SET_ALIASES
 * resolves to a code string the ENGLISH table owns get a DISTINCT key:
 * `ja-<encode>`. `jungle` -> `ja-base2`, `challenge-from-the-darkness` ->
 * `ja-gym2`, `base-expansion-pack` -> `ja-ecard1`, `dark-rush` -> `ja-bw4`.
 *
 * It is the fifth ruling in the sequence that began with
 * CF-THE-JAPANESE-CODE-IS-THE-KEY (R1-R4, 2026-09-01/04) and continued with
 * CF-THE-ENGLISH-SET-CODE-IS-THE-KEY (2026-09-06), and it obeys the same
 * standing doctrine as all of them: A RULED KEY MUST BE A normalizeSetKey
 * FIXED POINT.
 *
 * -- THE DEFECT IT ENDS, AND WHY R1-R4 COULD NOT REACH IT --------------------
 *
 * R1-R4 each moved a Japanese set OFF an English code and ONTO a bare Japanese
 * one -- `swsh12a` -> `s12a`, `paradigm-trigger` -> `s12`, `rocket-gang` ->
 * `japanese-rocket-gang`. Every one of those repairs was available because the
 * Japanese product HAD a code of its own to move to.
 *
 * These 38 do not. tcgdex serves 184 Japanese sets and 218 English ones, and
 * for these 38 products BOTH markets use the same id string: tcgdex's Japanese
 * "Jungle" is `base2` and so is its English one. The code table generator
 * (fetchPokemonSetCodes.cjs) drops a Japanese set whose id an English set
 * already holds -- `if (enByCode.has(code)) continue` -- which is why
 * POKEMON_JA_SET_CODES has 160 entries and not 184. There is no bare Japanese
 * code to rule toward, so R1-R4's shape of repair does not exist here.
 *
 * WHICH IS EXACTLY WHAT #1948 MEASURED AND CORRECTLY REFUSED TO ACT ON. That
 * census found 22,413 sold_comps rows stating Japanese under a key
 * `marketOfKey` reads as English, and split them:
 *
 *     16,701   shared code, ALREADY CORRECT -- left alone
 *      4,553   genuinely misfiled, a JA code resolves -- moved (R1-R4 keys)
 *      1,159   no JA code resolves -- parked
 *
 * The 16,701 were left alone because the JA vocabulary's own answer for such a
 * row IS the key it already sits on: relocating them would have been a no-op
 * onto their own key, and parking them would have pulled correctly-addressed
 * vintage sales out of pricing to fix a defect they did not have. #1948 named
 * this a VOCABULARY GAP -- "the key space cannot express the split" -- and
 * reported it rather than guessing. THIS MODULE IS THE KEY SPACE LEARNING TO
 * EXPRESS IT.
 *
 * Re-measured read-only 2026-09-07 on the same prefix scan (3,288,367 rows):
 * 17,045 such rows now, 18,210 JA-stated under an EN key in total. The
 * population grew because ingest keeps minting into it -- the mint is the
 * thing this ruling changes.
 *
 * -- WHY `ja-<code>` AND NOT A BARE CODE ------------------------------------
 *
 * The doctrine is "JA = bare JA code WHERE ONE EXISTS", and for these 38 none
 * does. The prefix is therefore not a preference, it is the only spelling
 * available that is (a) distinct from the English key, (b) derivable from the
 * English code by a rule a reader can check, and (c) unmistakably Japanese to
 * the market guard, which already reads `japanese-` as JA and now reads `ja-`
 * the same way.
 *
 * AND IT MUST NOT RENAME A SET THAT ALREADY HAS A REAL JA CODE. `s12a`, `s12`,
 * `sv2a`, `sv8a` and the nine R4 codes stay exactly as they are -- they are
 * bare Japanese codes and the doctrine says a bare JA code wins. This map is
 * built ONLY from destinations the English table owns and the Japanese one does
 * not, so a set with its own JA code can never enter it. Pinned by test.
 *
 * -- THE 19 THAT tcgdex CALLS AMBIGUOUS ARE IN SCOPE, DELIBERATELY -----------
 *
 * 19 of the 38 are in AMBIGUOUS_MARKET_CODES -- `neo1`, `sm10`, `xy2`, `sv10`
 * ... -- the ids tcgdex serves in BOTH markets for DIFFERENT products. That set
 * exists so a BARE code in a title decides no market, and this ruling does not
 * change that: a bare `sm10` is still English, still ambiguous, still refused
 * as a market witness. What changes is that a row which HAS stated Japanese in
 * its own text now has somewhere to go. Ambiguity about an unlabelled code and
 * an address for a labelled row are different questions.
 *
 * The other 19 (`base2`, `gym1`, `ecard3`, `bw4` ...) are ids the Japanese
 * market uses for a set tcgdex files only under English. Same defect, same fix.
 *
 * -- WHAT THIS COSTS, STATED BEFORE IT IS ASKED ------------------------------
 *
 * 19 of the 38 keys have a tcgdex-ja checklist behind them (1,565 cards, read
 * 2026-09-07 from api.tcgdex.net/v2/ja/sets) and 19 do not. A key with no
 * checklist row still STANDS -- it is the correct address for the sale -- but
 * CF-PRICE-ONLY-CHECKLIST-MATCHED-IDENTITIES means those pools do not price
 * until their checklist lands. That is not a regression: those rows are not
 * priced today either, they are merely pooled with the English card, which is
 * worse than unpriced. Absent beats wrong.
 *
 * NO DATA IS INVENTED HERE. Every pair is derived at build time from the two
 * committed, generated tables -- japanesePokemonAliases.ts and
 * pokemonSetCodes.ts. This module adds no third table to keep in sync; it
 * states a RULE over the ones that exist, exactly as pokemonEnglishSetKeyRuling
 * does for the English half.
 */
import { JAPANESE_POKEMON_SET_ALIASES } from "./japanesePokemonAliases.js";
import { POKEMON_EN_SET_CODES, POKEMON_JA_SET_CODES } from "./pokemonSetCodes.js";

/** The prefix a ruled Japanese vintage key carries. */
export const JA_KEY_PREFIX = "ja-";

/** The ruled Japanese key for an English set code. Pure string, no table. */
export function jaKeyForEnglishCode(code: string): string {
  return `${JA_KEY_PREFIX}${String(code ?? "").trim().toLowerCase()}`;
}

/**
 * The English codes this ruling covers: a JAPANESE alias destination that the
 * ENGLISH table owns and the JAPANESE table does not.
 *
 * BOTH HALVES OF THE TEST ARE LOAD-BEARING.
 *
 *   `POKEMON_EN_SET_CODES[code]` -- the destination is an English code, so a
 *   Japanese sale addressed there is sharing a key with an English product.
 *   Promo codes (POKEMON_PROMO_SET_CODES) are deliberately NOT consulted: the
 *   seven promo destinations (`bwp`, `svp`, `miscp` ...) are promo LINES, not
 *   dated set printings, and the Japanese promo lines have their own aliases
 *   (`j-promos` -> miscpj, `pcg-promos` -> pcgp) already. Ruling a promo line
 *   would mint a key for a product boundary nobody has drawn.
 *
 *   `!POKEMON_JA_SET_CODES[code]` -- the Japanese product has NO code of its
 *   own. This is the clause that keeps the doctrine: where a bare JA code
 *   exists it wins, and this map must never see that set. s12a, s12, sv2a,
 *   sv8a and the nine R4 codes are all excluded by it, by construction.
 *
 * Computed once, frozen. 38 codes on the tables as committed.
 */
function build(): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null);
  for (const code of new Set(Object.values(JAPANESE_POKEMON_SET_ALIASES))) {
    const c = String(code ?? "").trim().toLowerCase();
    if (!c) continue;
    if (!POKEMON_EN_SET_CODES[c]) continue;
    if (POKEMON_JA_SET_CODES[c]) continue;
    out[c] = jaKeyForEnglishCode(c);
  }
  return Object.freeze(out);
}

let cached: Readonly<Record<string, string>> | null = null;

/** English code -> ruled `ja-<code>` key, for every set the ruling covers. */
export function japaneseVintageKeyRewrites(): Readonly<Record<string, string>> {
  if (!cached) cached = build();
  return cached;
}

/** The ruled JA key for an English code, or null when the code is out of scope. */
export function ruledJapaneseVintageSetKey(code: string): string | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  return japaneseVintageKeyRewrites()[c] ?? null;
}

/**
 * The ruled JA keys themselves -- the 38 `ja-<code>` spellings.
 *
 * These are what must be normalizeSetKey FIXED POINTS, and what the market
 * guard must read as Japanese.
 */
export function ruledJapaneseVintageKeys(): readonly string[] {
  return Object.freeze(Object.values(japaneseVintageKeyRewrites()).slice().sort());
}

/** Is this a ruled `ja-<code>` key? Exact-token: `ja-base2` yes, `ja-` no. */
export function isRuledJapaneseVintageKey(key: string): boolean {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k.startsWith(JA_KEY_PREFIX)) return false;
  return Object.prototype.hasOwnProperty.call(
    japaneseVintageKeyRewrites(),
    k.slice(JA_KEY_PREFIX.length),
  );
}

/**
 * The JAPANESE alias table, with the 38 shared-code destinations rewritten to
 * their ruled `ja-<code>` keys -- what the resolver's Japanese branch answers
 * from after this ruling.
 *
 * Derived, never a second hand-maintained copy: re-running
 * fetchJapanesePokemonAliases regenerates the source table and this map follows
 * it automatically. An alias whose destination is out of scope is carried
 * through UNCHANGED, so R1-R4's keys and every Japanese-only code are exactly
 * what they were.
 */
function buildAliases(): Readonly<Record<string, string>> {
  const rewrites = japaneseVintageKeyRewrites();
  const out: Record<string, string> = Object.create(null);
  for (const [alias, code] of Object.entries(JAPANESE_POKEMON_SET_ALIASES)) {
    const c = String(code ?? "").trim().toLowerCase();
    out[alias] = rewrites[c] ?? code;
  }
  return Object.freeze(out);
}

let cachedAliases: Readonly<Record<string, string>> | null = null;

/** The Japanese alias table as the ruling leaves it. */
export function ruledJapaneseSetAliases(): Readonly<Record<string, string>> {
  if (!cachedAliases) cachedAliases = buildAliases();
  return cachedAliases;
}
