/**
 * CF-A-TCGPLAYER-ROW-STATES-ITS-OWN-IDENTITY (2026-09-08).
 *
 * THE DEFECT THIS ENDS. The first two-platform scheduled run (34262947046,
 * 18:05Z 2026-09-08) pulled 26,000 TCGplayer sales for 2026-09-07 and wrote
 * NINE. The other 25,991 died inside `persistVendorSalesToPool` at two lines:
 *
 *     if (!cardYear)   { result.skipped++; continue; }
 *     if (!playerName) { result.skipped++; continue; }
 *
 * Those are sports-card gates. A Pokemon card has no player and TCA sends
 * `year: null` on every TCGplayer row, so every row failed both, forever. The
 * run reconciled to zero unaccounted and looked healthy, because a 99.9% skip
 * and a quiet day are the same number when nothing names the reason.
 *
 * THE FIX IS TO SATISFY THE GATES, NOT TO EXEMPT THE VERTICAL. A Pokemon sale
 * has an identity as precise as a rookie card's -- it is just spelled with
 * different nouns. Per the standing Pokemon address ruling, the pool key is
 *
 *     hiq:pokemon:<year>:<tcgdex-setKey>:<cardNumber>:<finish>:no-auto
 *
 * so this module reads a TCA TCGplayer row into exactly those parts:
 *
 *   playerName  the CHARACTER name -- "Gengar" from
 *               "Gengar (48) - Expedition - Reverse Holofoil". The character
 *               is what a Pokemon collector searches, prices and compares, so
 *               it occupies the player slot rather than being bolted on beside
 *               it. One identity field, one meaning per vertical.
 *   cardYear    the SET's release year, from pokemonSetYear(). Never the sale
 *               year -- a 2026 sale of a 2002 Expedition Gengar is a 2002
 *               card, and dating it 2026 would file it under the sale-year
 *               slugs that CF-VINTAGE-SALES-UNDER-SALE-YEAR-SLUGS already
 *               measured as a ~180k-row defect elsewhere in the pool.
 *   cardNumber  TCA's structured `card_number`, preferred over the title.
 *   setKey      the tcgdex CODE, per CF-THE-ENGLISH-SET-CODE-IS-THE-KEY.
 *   finish      folded per the finish ruling -- holo -> holofoil, and the
 *               whole reverse family -> reverse-holofoil, via the committed
 *               `pokemonFinishFromTitle`, which is NOT re-implemented here.
 *
 * WHY THE STRUCTURED FIELDS AND NOT THE EXISTING TITLE PARSER. Measured on
 * real 2026-09-07 rows, `inferSetKeyFromTitle` reads TCGplayer's title format
 * wrong in the way that matters most: "Charizard ex (223) - Obsidian Flames -
 * Holofoil" resolved to **"Panini Obsidian"** -- a sports pool -- and
 * "Expedition" and "151" both resolved to "Unknown". That is precisely the
 * cross-vertical leak CF-NO-CROSS-VERTICAL-FALLBACK forbids. TCA already hands
 * us `card_set` and `card_number` as clean structured fields, so the set is
 * read from the field and the character from the title's leading segment. The
 * finish and card-number READERS are reused unchanged; only the set and
 * character derivations are new, because those are the two the title format
 * defeats.
 *
 * AN UNMAPPED SET IS A COUNTED SKIP, NEVER A GUESS. If the vocabulary cannot
 * name the set, there is no year and no key, and the row returns
 * `skippedSetUnmapped`. Measured over 3,000 rows of the 2026-09-07 window,
 * 95.9% of rows resolve; the 4.1% residual is grab-bags and trainer kits
 * ("Miscellaneous Cards & Products", "Blister Exclusives", McDonald's promos)
 * that genuinely are not single-set products.
 */

import { POKEMON_SET_ALIASES } from "../catalog/pokemonSetAliases.js";
import { POKEMON_EN_SET_CODES, POKEMON_PROMO_SET_CODES } from "../catalog/pokemonSetCodes.js";
import { pokemonSetYear } from "../catalog/pokemonSetYears.js";
import { slugify } from "./hobbyIqCardId.service.js";
import { pokemonFinishFromTitle } from "./pokemonFinishFromTitle.js";

/** tcgdex set NAME (slugified) -> its code. The reverse of the generated
 *  tables, built once so a TCGplayer label that IS the tcgdex name resolves
 *  without needing a seller-spelling alias to exist for it. */
const NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze(
  (() => {
    const out: Record<string, string> = {};
    for (const [code, name] of Object.entries(POKEMON_EN_SET_CODES)) out[slugify(name)] = code;
    for (const [code, name] of Object.entries(POKEMON_PROMO_SET_CODES)) out[slugify(name)] = code;
    return out;
  })(),
);

/**
 * The spellings a TCGplayer `card_set` label might be, most specific first.
 *
 * Each transform below is here because a MEASURED row needed it, not because
 * it seemed plausible; the comment on each names the label that motivated it.
 */
function setCandidates(label: string): string[] {
  const out: string[] = [];
  const push = (s: string) => { const v = slugify(s); if (v && !out.includes(v)) out.push(v); };

  push(label);

  // "ME04: Chaos Rising", "SWSH07: Evolving Skies", "SV: Scarlet & Violet 151".
  // TCGplayer prefixes the era code; either half can be the vocabulary's key.
  const era = /^([A-Za-z]+[0-9.]*)\s*:\s*(.+)$/.exec(label);
  const tail = era ? era[2] : label;
  if (era) {
    push(era[1]);
    push(tail);
    // "SV: Scarlet & Violet 151" -> "151". The era name repeats in the tail.
    push(tail.replace(/^(scarlet\s*&?\s*violet|sword\s*&?\s*shield|mega evolution)\s+/i, ""));
    // "ME: Mega Evolution Promo" -> `mep`; "SV: ... Promo Cards" -> `svp`.
    // The promo table is keyed by era code + "p".
    if (/promo/i.test(tail)) push(`${era[1]}p`);
  }

  for (const base of era ? [label, tail] : [label]) {
    // "Diamond and Pearl" vs tcgdex "Diamond & Pearl", and the reverse.
    push(base.replace(/\band\b/gi, "&"));
    push(base.replace(/&/g, "and"));
    // TCGplayer clips "Base Set" off the e-card era: "Expedition" -> ecard1.
    push(`${base} base set`);
    // "Black and White Promos" -> "BW Black Star Promos" shape.
    push(base.replace(/\bpromos?(\s+cards)?\b/gi, "black star promos"));
  }
  return out;
}

/** The tcgdex code for a TCGplayer set label, or null when unmapped. */
export function tcgPlayerSetKey(label: string | null | undefined): string | null {
  if (!label) return null;
  for (const k of setCandidates(String(label))) {
    const aliased = POKEMON_SET_ALIASES[k];
    if (aliased) return aliased;
    const byName = NAME_TO_CODE[k];
    if (byName) return byName;
    // The label already IS a code ("ME04" -> me04).
    if ((POKEMON_EN_SET_CODES as Record<string, string>)[k]
      || (POKEMON_PROMO_SET_CODES as Record<string, string>)[k]) return k;
  }
  return null;
}

/**
 * The character name from a TCGplayer title.
 *
 * TCGplayer's format is strictly "<Card Name> - <Set> - <Finish>", optionally
 * with a parenthesised number on the name: "Gengar (48) - Expedition -
 * Reverse Holofoil". The character is the first hyphen-delimited segment with
 * that number removed.
 *
 * Rarity and mechanic suffixes STAY on the name -- "Charizard ex" and
 * "Pikachu VMAX" are different cards from "Charizard" and "Pikachu", printed
 * separately with their own print runs and their own prices, so stripping them
 * would collapse distinct pools. This is the same reasoning as
 * CF-RED-INK-IS-THE-BW-SHIMMER-SSP: a name that the market prices separately
 * is a separate card line.
 */
export function tcgPlayerCharacterName(title: string | null | undefined): string | null {
  if (!title) return null;
  const first = String(title).split(" - ")[0] ?? "";
  const name = first
    .replace(/\s*\((?:[^)]*)\)\s*$/, "")  // trailing "(48)" / "(SWSH123)"
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** Why a TCGplayer row could not be addressed. `null` reason == addressed. */
export type TcgPlayerIdentityReason = "set-unmapped" | "no-card-number" | "no-character";

export interface TcgPlayerIdentity {
  playerName: string | null;
  cardYear: number | null;
  cardNumber: string | null;
  setKey: string | null;
  parallel: string | null;
  sport: "pokemon";
  reason: TcgPlayerIdentityReason | null;
}

/** A TCA row as this reader needs it -- the four fields it actually reads. */
export interface TcaTcgRowLike {
  title?: string | null;
  card_set?: string | null;
  card_number?: string | null;
  platform?: string | null;
  category?: string | null;
}

/**
 * Read a TCA TCGplayer row into the Pokemon identity fields.
 *
 * Returns a `reason` instead of throwing, so the caller can COUNT the refusal
 * by name -- the whole point of this change is that a skipped row says why.
 */
export function tcgPlayerRowIdentity(row: TcaTcgRowLike): TcgPlayerIdentity {
  const title = row?.title ?? null;
  const base: TcgPlayerIdentity = {
    playerName: null, cardYear: null, cardNumber: null,
    setKey: null, parallel: null, sport: "pokemon", reason: null,
  };

  const setKey = tcgPlayerSetKey(row?.card_set);
  if (!setKey) return { ...base, reason: "set-unmapped" };

  const cardYear = pokemonSetYear(setKey);
  // A mapped set with no derivable year is the same dead end as an unmapped
  // one, and is reported as such: either way the vocabulary cannot date the
  // card and we refuse to invent a year for it.
  if (!cardYear) return { ...base, setKey, reason: "set-unmapped" };

  const playerName = tcgPlayerCharacterName(title);
  if (!playerName) return { ...base, setKey, cardYear, reason: "no-character" };

  // TCA's structured field first -- "048/165" carries the set total, which is
  // not part of the number, so the numerator is the card number.
  const raw = row?.card_number ? String(row.card_number).trim() : "";
  const cardNumber = raw ? (raw.split("/")[0] || "").trim() || null : null;
  if (!cardNumber) return { ...base, setKey, cardYear, playerName, reason: "no-card-number" };

  const finish = title ? pokemonFinishFromTitle(title) : null;

  return {
    playerName,
    cardYear,
    cardNumber,
    setKey,
    // The finish IS the card line (finish ruling). "Normal" is the base line
    // and carries no parallel, exactly as a base sports card carries none.
    parallel: finish && finish.token !== "normal" ? finish.display : null,
    sport: "pokemon",
    reason: null,
  };
}

/**
 * Whether a TCA row is a TCGplayer/TCG row this reader owns.
 *
 * Keyed on the markers TCA stamps, never on the title -- a sports card whose
 * title happens to name a Pokemon is still a sports card, and this gate must
 * not be the thing that decides otherwise.
 */
export function isTcgPlayerRow(row: TcaTcgRowLike): boolean {
  return String(row?.platform ?? "").toLowerCase() === "tcgplayer"
    || String(row?.category ?? "").toLowerCase() === "tcg";
}
