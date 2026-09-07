"use strict";
/**
 * CF-THE-JAPANESE-SET-IS-REACHED-BY-ITS-JAPANESE-ID (2026-09-07), the third
 * step of the R5 sequence, and the one #1971 deliberately deferred.
 *
 * #1959 (R5) ruled the ADDRESS: a Japanese set sharing an English set code is
 * keyed `ja-<encode>` -- `jungle` -> `ja-base2`. #1971 fixed the SCOPE: both
 * tcgdex lanes stopped dropping (and stopped mis-keying) the 19 JA sets tcgdex
 * happens to serve under an id that case-folds onto an English one.
 *
 * This module answers the question those two left open, and which
 * `ja-shared-code-checklist-acquisition-2026-09-07.md` measured:
 *
 *   "8 of the 19 are not acquisitions at all. tcgdex serves the Japanese
 *    product, under its own Japanese id -- PMCG2, E1 -- and our lanes never
 *    asked for it, because they searched by the ENGLISH code."
 *
 * There IS no JA set called `base2`. The Japanese Jungle is `PMCG2`. So for
 * these eight the ruled key cannot be derived from the source id the way
 * `jaSetKeyFor` derives it for SM10 -- `pmcg2` case-folds onto no English code,
 * and the lane would key it `pmcg2`, an address the resolver never answers and
 * no sale ever lands on.
 *
 * -- WHY THIS IS A DERIVATION AND NOT A SECOND TABLE OF FACTS ---------------
 *
 * Under R5 the mapping JA-source-id -> `ja-<encode>` is MECHANICAL for a set
 * that is the same product as the English set: the ruling already says the
 * Japanese print of the English `base2` product is addressed `ja-base2`, and
 * the alias table already says `jungle -> base2`. The only thing missing is
 * the statement THIS tcgdex id IS that product -- which is a fact about the
 * source's catalogue, not about our vocabulary, and is therefore stated here
 * once, with its evidence, rather than inferred by a string rule that would
 * have to guess.
 *
 * EVERY PAIR CARRIES ITS EVIDENCE, read live from tcgdex 2026-09-07
 * (api.tcgdex.net/v2, 218 EN sets / 184 JA). Two independent witnesses are
 * required and both are recorded on the row:
 *
 *   NAME EQUIVALENCE  the JA set's own name is the English set's name, in
 *                     Japanese: PMCG2 is the Japanese for "Pokemon Jungle" and
 *                     EN base2 is "Jungle".
 *   ERA/ORDER         the JA print precedes its English localisation by the
 *                     era's known lag, and the two sit at the same ordinal
 *                     within corresponding series (JA e-card serie = EN
 *                     E-Card, JA neo serie = EN Neo).
 *
 * Both witnesses are ALREADY corroborated inside this repo: every English code
 * on a row below is the destination the committed JAPANESE_POKEMON_SET_ALIASES
 * table gives for that set's own Japanese name (`jungle` -> `base2`,
 * `base-expansion-pack` -> `ecard1`). This module adds the source id, not the
 * identity.
 *
 * -- THE REFUSAL IS THE POINT, AND IT HAS A FIXTURE -------------------------
 *
 * A JA id that is NOT the same product MUST NOT map, and the acquisition report
 * names the case exactly:
 *
 *   PCG1 (2004-04-09, PCG serie, 82 cards)
 *   dp1  "Diamond & Pearl" (2007-05-01, Diamond & Pearl serie, 130 cards)
 *
 * Different serie, different era, three years apart, and the JA alias
 * `space-time-creation` names a 2007 JA product tcgdex does not serve at all.
 * Minting PCG1 onto `ja-dp1` would be R5's own defect in the other direction --
 * a different card on a shared address -- so `PCG1` is pinned as a fixture that
 * MUST refuse. The four DP cells stay open, as the report left them.
 *
 * This module states no card and fetches nothing. It maps an id to an address.
 */

const { slugCode, JA_KEY_PREFIX } = require("./tcgdex-ja-set-key.cjs");

/**
 * tcgdex JA set id -> the English set code whose product it is, with the
 * evidence for that identity.
 *
 * `enCode` is the ENGLISH code, never the key: the key is DERIVED from it by
 * the ruling's own rule (`ja-<encode>`), so this table can never disagree with
 * R5 about the spelling of an address.
 */
const JA_SOURCE_ID_PRODUCTS = Object.freeze({
  PMCG1: Object.freeze({
    enCode: "base1",
    jaName: "拡張パック",
    enName: "Base Set",
    jaRelease: "1996-10-20",
    enRelease: "1999-01-09",
    jaCards: 102,
    alias: "expansion-pack",
    evidence:
      "the original Japanese Base Set; the committed alias `expansion-pack` -> base1 already names this identity, and both markets card the set at 102",
  }),
  PMCG2: Object.freeze({
    enCode: "base2",
    jaName: "ポケモンジャングル",
    enName: "Jungle",
    jaRelease: "1997-03-05",
    enRelease: "1999-06-16",
    jaCards: 48,
    alias: "jungle",
    evidence:
      "name equivalence is exact -- the JA name transliterates to 'Pokemon Jungle'; alias `jungle` -> base2; second set of the corresponding serie in both markets",
  }),
  PMCG3: Object.freeze({
    enCode: "base3",
    jaName: "化石の秘密",
    enName: "Fossil",
    jaRelease: "1997-06-21",
    enRelease: "1999-10-10",
    jaCards: 48,
    alias: "mystery-of-the-fossils",
    evidence:
      "the JA name means 'Mystery of the Fossils', which is the alias the committed table already maps to base3; third set of the serie in both markets",
  }),
  PMCG5: Object.freeze({
    enCode: "gym1",
    jaName: "リーダーズスタジアム",
    enName: "Gym Heroes",
    jaRelease: "1998-10-24",
    enRelease: "2000-08-14",
    jaCards: 96,
    // The committed alias is `leaders-x27-stadium`, not `leaders-stadium`:
    // the set is "Leaders' Stadium" and the generator escaped the apostrophe.
    // The acquisition report's prose spells it without, and copying the prose
    // rather than the table is exactly what the alias pin caught.
    alias: "leaders-x27-stadium",
    evidence:
      "the JA name transliterates to \"Leaders' Stadium\", the Gym-serie opener; alias `leaders-x27-stadium` -> gym1",
  }),
  PMCG6: Object.freeze({
    enCode: "gym2",
    jaName: "闇からの挑戦",
    enName: "Gym Challenge",
    jaRelease: "1999-06-25",
    enRelease: "2000-10-16",
    jaCards: 98,
    alias: "challenge-from-the-darkness",
    evidence:
      "the JA name means 'Challenge from the Darkness'; alias `challenge-from-the-darkness` -> gym2; second Gym set in both markets",
  }),
  E1: Object.freeze({
    enCode: "ecard1",
    jaName: "基本拡張パック",
    enName: "Expedition Base Set",
    jaRelease: "2001-12-01",
    enRelease: "2002-09-15",
    jaCards: 128,
    alias: "base-expansion-pack",
    evidence:
      "serie equivalence is explicit -- the JA serie IS the E-Card serie; the JA name means 'Base Expansion Pack', alias `base-expansion-pack` -> ecard1",
  }),
  E2: Object.freeze({
    enCode: "ecard2",
    jaName: "地図にない町",
    enName: "Aquapolis",
    jaRelease: "2002-03-08",
    enRelease: "2003-01-15",
    jaCards: 92,
    alias: "the-town-on-no-map",
    evidence:
      "the JA name means 'The Town on No Map', alias `the-town-on-no-map` -> ecard2; second E-Card set in both markets",
  }),
  E3: Object.freeze({
    enCode: "ecard3",
    jaName: "海からの風",
    enName: "Skyridge",
    jaRelease: "2002-05-24",
    enRelease: "2003-05-12",
    jaCards: 90,
    alias: "wind-from-the-sea",
    evidence:
      "the JA name means 'Wind from the Sea', alias `wind-from-the-sea` -> ecard3; third E-Card set in both markets",
  }),
});

/**
 * JA ids whose ruled key is a NAMED key, not a code at all.
 *
 * R1-R4 moved several Japanese sets onto keys that are neither a bare code nor
 * a `ja-<code>`: `rocket-gang` -> `japanese-rocket-gang`. That key is where the
 * catalog ALREADY holds the rows -- 65 tcgdex-ja rows plus 14 sales-attested,
 * per the alias table's own note -- so a lane that keyed PMCG4 by its bare code
 * would open a SECOND pool for a set that already has one, which is the
 * one-card-one-row defect this whole sequence exists to close.
 *
 * The old name-slug key (`1997-japanese-rocket-gang-pokemon`) produced the
 * right setKey by accident, via `normalizeSetKey(setName)`. Deriving the key
 * from the id turns that accident into a regression unless the ruled name is
 * stated, so it is stated here.
 *
 * These are NOT in JA_SOURCE_ID_PRODUCTS: the set has no English twin, so
 * there is no English code to derive from and nothing for R5 to spell.
 */
const JA_SOURCE_ID_RULED_NAMED_KEYS = Object.freeze({
  PMCG4: "japanese-rocket-gang",
});

/**
 * JA ids that LOOK mappable and MUST NOT map, with the reason.
 *
 * Stated rather than merely absent, so a later reader who notices `PCG1` has no
 * mapping finds the ruling instead of an oversight -- and so the refusal is
 * testable. `sameProductAsEnglishSet` reads this FIRST, so adding a row here
 * can only ever remove a mapping, never create one.
 */
const JA_SOURCE_ID_REFUSALS = Object.freeze({
  PCG1: Object.freeze({
    consideredFor: "dp1",
    jaRelease: "2004-04-09",
    enRelease: "2007-05-01",
    reason:
      "DIFFERENT PRODUCT. PCG1 (2004-04-09, PCG serie, 82 cards) is not the Japanese print of EN dp1 Diamond & Pearl (2007-05-01, Diamond & Pearl serie, 130 cards) -- three years and a whole serie apart. The JA alias `space-time-creation` names a 2007 JA product tcgdex does not serve.",
  }),
  PCG2: Object.freeze({
    consideredFor: "dp2",
    jaRelease: "2004-07-01",
    enRelease: "2007-08-01",
    reason:
      "DIFFERENT PRODUCT. PCG2 (2004-07-01, PCG serie) is a 2004 PCG-era set with its own id, already in the universe under it; EN dp2 Mysterious Treasures is 2007-08-01.",
  }),
  PCG3: Object.freeze({
    consideredFor: "dp3",
    jaRelease: "2004-10-15",
    enRelease: "2007-11-01",
    reason:
      "DIFFERENT PRODUCT. PCG3 (2004-10-15, PCG serie); EN dp3 Secret Wonders is 2007-11-01.",
  }),
  PCG6: Object.freeze({
    consideredFor: "dp6",
    jaRelease: "2005-10-28",
    enRelease: "2008-08-01",
    reason:
      "DIFFERENT PRODUCT. PCG6 (2005-10-28, PCG serie); EN dp6 Legends Awakened is 2008-08-01.",
  }),
});

/**
 * THE TWO TABLES MUST BE DISJOINT, and that is checked AT LOAD, not hoped for.
 *
 * `sameProductAsEnglishSet` consults refusals first, so a row in both tables
 * would refuse -- but only for as long as nobody reorders those two lines, and
 * a test that merely asserts "the refused ids are not in the products table"
 * passes with the refusal check deleted (mutation-verified: it survived).
 *
 * An assert makes the contested state unconstructible instead of untested. The
 * failure it prevents is concrete: the four DP cells are exactly the ones a
 * later reader will want to close, and adding `PCG1` to the products table
 * without removing its refusal must be a loud error rather than a silent
 * reordering risk.
 */
function assertDisjoint(products, refusals) {
  for (const id of Object.keys(products)) {
    if (Object.prototype.hasOwnProperty.call(refusals, id)) {
      throw new Error(
        `tcgdex-ja-source-id-map: ${id} is BOTH mapped and refused. A refused id is a product ` +
        `identity we have declined to assert; give it a mapping only by removing its refusal, ` +
        `and only with the evidence that changed.`,
      );
    }
  }
  return true;
}

assertDisjoint(JA_SOURCE_ID_PRODUCTS, JA_SOURCE_ID_REFUSALS);

/**
 * The English product this JA source id IS, or null.
 *
 * Null covers three different things and deliberately does not distinguish
 * them to the caller, because all three mean the same thing to a lane: do not
 * rewrite this id's key.
 *
 *   - a JA id with a bare Japanese code of its own (`S12a`, `SV8a`, `PMCG4`)
 *   - a JA id whose case-folded code IS the English one (`SM10`, `neo1`) --
 *     those are `jaSetKeyFor`'s business, not this module's
 *   - a JA id explicitly REFUSED above (`PCG1`)
 */
function sameProductAsEnglishSet(jaId) {
  const id = String(jaId ?? "").trim();
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(JA_SOURCE_ID_REFUSALS, id)) return null;
  return JA_SOURCE_ID_PRODUCTS[id] ?? null;
}

/** Why a refused id is refused, or null when it was never considered. */
function refusalFor(jaId) {
  const id = String(jaId ?? "").trim();
  if (!id) return null;
  return JA_SOURCE_ID_REFUSALS[id] ?? null;
}

/**
 * The ruled `ja-<encode>` key for a JA source id, or null.
 *
 * Derived through R5's own rule from the English code on the row -- this
 * module never spells an address itself.
 */
function ruledKeyForJaSourceId(jaId) {
  const id = String(jaId ?? "").trim();
  if (!id) return null;
  // A key R1-R4 ruled by NAME wins outright: it is already the address the
  // catalog holds these rows under, and no derivation may move a pool.
  if (Object.prototype.hasOwnProperty.call(JA_SOURCE_ID_RULED_NAMED_KEYS, id)) {
    return JA_SOURCE_ID_RULED_NAMED_KEYS[id];
  }
  const product = sameProductAsEnglishSet(id);
  if (!product) return null;
  const code = slugCode(product.enCode);
  return code ? `${JA_KEY_PREFIX}${code}` : null;
}

/** Every id this module maps, sorted. */
function mappedJaSourceIds() {
  return Object.freeze(Object.keys(JA_SOURCE_ID_PRODUCTS).slice().sort());
}

/** Every id this module explicitly refuses, sorted. */
function refusedJaSourceIds() {
  return Object.freeze(Object.keys(JA_SOURCE_ID_REFUSALS).slice().sort());
}

module.exports = {
  JA_SOURCE_ID_PRODUCTS,
  JA_SOURCE_ID_REFUSALS,
  JA_SOURCE_ID_RULED_NAMED_KEYS,
  sameProductAsEnglishSet,
  refusalFor,
  ruledKeyForJaSourceId,
  mappedJaSourceIds,
  refusedJaSourceIds,
  assertDisjoint,
};
