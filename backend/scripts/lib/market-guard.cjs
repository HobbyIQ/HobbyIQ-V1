"use strict";
/**
 * market-guard.cjs -- "a Japanese card is not an English card, and a re-key may
 * never cross that line".
 *
 * CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01) and
 * CF-THE-ENGLISH-SET-CODE-IS-THE-KEY (Drew, 2026-09-06), enforced at the one
 * place that moves rows BETWEEN keys in bulk.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `rekey-product-setkey MODE=catalog` adopts a row by its ID STEM and moves it
 * to TO. Before this guard, the only thing that could stop a move was a
 * DIFFERENT PLAYER at the destination (CF-A-FOLD-NEVER-CHANGES-THE-PLAYER).
 * Player is the wrong axis for this hazard, because the two markets print the
 * SAME Pokemon at the SAME number: every check that guard makes passes, and
 * the row moves anyway.
 *
 * Measured read-only 2026-09-06 on the cell the ruling names -- pokemon/2023,
 * setKey `151` -> `sv03-5` (the ENGLISH tcgdex code for Scarlet & Violet 151):
 *
 *     715 catalog rows carry setKey `151`, across three setNames
 *       398  "2023 151 Pokemon"                            (pokemon-tcg-data)
 *       169  "2023 Pokemon Scarlet & Violet 151"           ENGLISH
 *       148  "2023 Pokemon Japanese Scarlet & Violet 151"  JAPANESE
 *
 * All 148 Japanese rows share their card number with an English row naming the
 * SAME PLAYER -- 148 of 148, zero different-player pairs. So the player guard
 * had nothing to object to, and report run 34061675440 duly said 0 REFUSED:
 * 146 of those rows would have MINTED FRESH ENGLISH IDENTITIES under `sv03-5`,
 * pooling Japanese Master Ball and Reverse Foil cards -- a different print, a
 * different market, a different price -- into the English card's pool.
 *
 * ── WHY THE MARKET IS READ FROM THE ROW, NOT INFERRED FROM THE KEY ──────────
 *
 * `resolveSetKeyForSlug` already draws this line and draws it on the SET NAME:
 * hobbyIqCardId.service.ts:1817 tests `/japanese/i` against setName BEFORE the
 * English alias table is ever consulted, precisely so "Pokemon Japanese
 * Scarlet & Violet 151" cannot hit the English `151` alias. This guard is that
 * same test, applied one layer up, to a row that is ALREADY WRONGLY KEYED and
 * is about to be moved somewhere that makes it permanent. Reusing the rule
 * rather than restating it is what keeps the two from drifting apart.
 *
 * THE STORED KEY IS THE SECOND WITNESS. A row whose setName says nothing can
 * still be Japanese by its own key: `sv2a` is a Japanese-only code, and the
 * `japanese-<code>` spelling is a known minter artefact
 * (hobbyIqCardId.service.ts:1085). Either witness is enough to fix a market.
 *
 * ── THE 24 AMBIGUOUS CODES ARE NOT A MARKET ─────────────────────────────────
 *
 * `neo1`, `sm1`, `xy2` ... name DIFFERENT products in the two markets, which is
 * why `AMBIGUOUS_MARKET_CODES` exists and why the resolver refuses them from a
 * bare code. A code in that set therefore fixes NO market here either: it is
 * `unknown`, and an unknown side never triggers a refusal on its own. This
 * guard refuses a STATED CONTRADICTION, never a silence -- a lane that refused
 * on ignorance would refuse most of its corpus and be turned off.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It is Pokemon-only, because the EN/JA split is a Pokemon fact and the code
 * tables are Pokemon tables. Every other sport answers `null` (no opinion) and
 * the lane behaves exactly as it did before.
 */

const path = require("node:path");

/**
 * The code tables, loaded from the BUILT tree -- the same tables
 * `normalizeSetKey` and the resolver read, so this guard can never disagree
 * with them about which code belongs to which market.
 *
 * DEFENSIVE LOAD, deliberately. This module is required by an ops script whose
 * own contract is that it can be loaded (and its dispatch refusals driven)
 * WITHOUT a compiled tree -- that is what rekeyRetireUntwinned.test.ts does. A
 * missing dist/ therefore degrades to "no code table", not to a crash: the
 * setName witness still works, and the caller still gets a verdict.
 */
function loadCodeTables() {
  try {
    const backend = path.resolve(__dirname, "..", "..");
    const m = require(path.join(backend, "dist/services/catalog/pokemonSetCodes.js"));
    return {
      en: m.POKEMON_EN_SET_CODES || {},
      ja: m.POKEMON_JA_SET_CODES || {},
      ambiguous: m.AMBIGUOUS_MARKET_CODES || new Set(),
    };
  } catch {
    return { en: {}, ja: {}, ambiguous: new Set() };
  }
}

let cached = null;
function tables() {
  if (!cached) cached = loadCodeTables();
  return cached;
}

/** Test seam: force the tables (used to pin behaviour without a built tree). */
function __setTables(t) { cached = t; }

/**
 * The market a KEY states, or null.
 *
 * `null` means "this key does not state a market" -- either it is not a code at
 * all, or it is one of the 24 both markets use for different products. Null is
 * never an accusation.
 */
function marketOfKey(key) {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return null;
  const { en, ja, ambiguous } = tables();
  // The `japanese-<code>` minter artefact states JA outright, whatever follows.
  if (/^japanese-/.test(k)) return "ja";
  // A code both markets use for DIFFERENT products states nothing.
  if (ambiguous.has && ambiguous.has(k)) return null;
  const isEn = Boolean(en[k]);
  const isJa = Boolean(ja[k]);
  // A code in both tables and not in the ambiguous set: still not a witness.
  if (isEn && isJa) return null;
  if (isJa) return "ja";
  if (isEn) return "en";
  return null;
}

/**
 * The market a ROW states, or null.
 *
 * Two witnesses, and the SET NAME is asked first -- the same order
 * `resolveSetKeyForSlug` uses, for the same reason: the name is what a human
 * transcribed about the product, and it is the field the Japanese rows in this
 * corpus actually carry ("2023 Pokemon Japanese Scarlet & Violet 151").
 *
 * `/japanese/i` is the resolver's own test, verbatim. `jp`/`jpn`/`japan` are
 * accepted as WHOLE WORDS so "Japan" and "JPN" in a vendor label count while a
 * word merely containing them cannot. `\bjp\b` is deliberately narrow: a bare
 * "JP" is a market statement, "jpop" is not.
 */
function marketOfRow(row) {
  const name = String(row?.setName ?? "").trim();
  const title = String(row?.title ?? "").trim();
  const text = `${name} ${title}`;
  if (/japanese/i.test(text) || /\b(?:jpn?|japan)\b/i.test(text)) return "ja";
  // The row's own stored key is the second witness.
  const viaKey = marketOfKey(row?.setKey);
  if (viaKey) return viaKey;
  // ...and failing that, the key its ID stems from.
  const parts = String(row?.id ?? "").split(":");
  if (parts.length >= 5 && parts[0] === "hiq") return marketOfKey(parts[3]);
  return null;
}

/**
 * May this row be re-keyed onto `toKey`?
 *
 * Returns { allowed, reason, rowMarket, toMarket }. `allowed:false` carries
 * `reason: "cross-market"` -- the NAMED refusal the banner counts and the
 * reconciliation accounts for.
 *
 * THE RULE, STATED ONCE: a refusal needs BOTH SIDES TO SPEAK AND TO DISAGREE.
 * If either side is silent the move proceeds exactly as it did before this
 * guard existed, so the guard can only ever subtract wrong moves -- it can
 * never invent a refusal out of missing data. That is what makes it safe to
 * arm on every dispatch rather than behind a flag.
 */
function marketVerdict(row, toKey, sport) {
  // Pokemon-only: the EN/JA split is a Pokemon fact and these are Pokemon tables.
  const sp = String(sport ?? row?.sport ?? "").trim().toLowerCase();
  if (sp && sp !== "pokemon") return { allowed: true, reason: null, rowMarket: null, toMarket: null };
  const rowMarket = marketOfRow(row);
  const toMarket = marketOfKey(toKey);
  if (!rowMarket || !toMarket || rowMarket === toMarket) {
    return { allowed: true, reason: null, rowMarket, toMarket };
  }
  return { allowed: false, reason: "cross-market", rowMarket, toMarket };
}

module.exports = { marketOfKey, marketOfRow, marketVerdict, __setTables };
