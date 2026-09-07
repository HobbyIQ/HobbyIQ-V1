import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  japaneseVintageKeyRewrites,
  isRuledJapaneseVintageKey,
} from "../src/services/catalog/japaneseVintageSetKeyRuling.js";
import { AMBIGUOUS_MARKET_CODES } from "../src/services/catalog/pokemonSetCodes.js";

/**
 * CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (R5, #1959) -- the INGEST side.
 *
 * #1959 ruled the address (`ja-<code>`) and stated the cost: 19 of the 38 ruled
 * keys have a tcgdex-ja checklist upstream that our own table declined to hold,
 * because both staging lanes carry the generator's exclusion in their own
 * spelling -- `ja.filter((s) => !enIds.has(s.id))`.
 *
 * These pins are over the COMMITTED helper, with tcgdex's real id
 * capitalisation as measured live 2026-09-07 (218 EN sets, 184 JA). No network.
 *
 * THE DEFECT WAS CASE, AND IT CUT BOTH WAYS -- which is why a test that only
 * checked "is it dropped?" would have passed on 15 of the 19:
 *
 *   neo1..neo4   lowercase in both markets -> matched -> DROPPED (323 cards)
 *   SM, XY, SV10  uppercase in JA only -> NOT matched -> kept, then staged under
 *                `s.id.toLowerCase()`, i.e. the ENGLISH key
 *
 * The second is the one that costs rows: it is how 42 catalog rows of
 * "Japanese ロケット団の栄光" came to sit on the English `sv10` key.
 */

const require_ = createRequire(import.meta.url);
const lib = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "scripts", "lib", "tcgdex-ja-set-key.cjs",
);
const { jaSetKeyFor, sharesEnglishCode, slugCode } = require_(lib);

/** The 19 ruled codes tcgdex serves a Japanese set under, with the id spelled
 *  as tcgdex spells it. Read live 2026-09-07 from api.tcgdex.net/v2/ja/sets. */
const JA_SETS_SHARING_AN_EN_CODE: ReadonlyArray<readonly [string, string]> = [
  ["neo1", "neo1"], ["neo2", "neo2"], ["neo3", "neo3"], ["neo4", "neo4"],
  ["SM6", "sm6"], ["SM7", "sm7"], ["SM8", "sm8"], ["SM9", "sm9"],
  ["SM10", "sm10"], ["SM11", "sm11"], ["SM12", "sm12"],
  ["SV10", "sv10"],
  ["XY2", "xy2"], ["XY3", "xy3"], ["XY4", "xy4"],
  ["XY6", "xy6"], ["XY7", "xy7"], ["XY9", "xy9"], ["XY10", "xy10"],
];

/** Every English id the JA scope collides with, lowercase as tcgdex serves EN. */
const EN_IDS = new Set([
  ...JA_SETS_SHARING_AN_EN_CODE.map(([, code]) => code),
  "base1", "base2", "base3", "gym1", "gym2", "swsh2", "swsh3", "swsh4",
  "sv08-5", "sm1", "sm2", "sm3", "sm4", "sm5",
]);

describe("tcgdex JA sets that share an English code", () => {
  it("pins the 19 the ruling covers and tcgdex actually serves", () => {
    expect(JA_SETS_SHARING_AN_EN_CODE).toHaveLength(19);
    // Every one is a code #1959 ruled -- this test cannot drift from the ruling.
    const ruled = japaneseVintageKeyRewrites();
    for (const [, code] of JA_SETS_SHARING_AN_EN_CODE) {
      expect(ruled[code], `${code} must be a ruled code`).toBe(`ja-${code}`);
    }
  });

  it("stages each under its ruled ja- key, not the English one", () => {
    for (const [jaId, code] of JA_SETS_SHARING_AN_EN_CODE) {
      const key = jaSetKeyFor(jaId, EN_IDS);
      expect(key, `${jaId} must not land on the English key`).toBe(`ja-${code}`);
      expect(key).not.toBe(code);
      expect(isRuledJapaneseVintageKey(key)).toBe(true);
    }
  });

  it("catches the collision the old exact-case compare missed", () => {
    // The 15 uppercase ids: `enIds.has(s.id)` answered false, so they were KEPT
    // and then keyed English. Case-folded, the collision is visible.
    const uppercase = JA_SETS_SHARING_AN_EN_CODE.filter(([jaId]) => /[A-Z]/.test(jaId));
    expect(uppercase).toHaveLength(15);
    for (const [jaId] of uppercase) {
      expect(EN_IDS.has(jaId), "the old exact-case compare saw no collision").toBe(false);
      expect(sharesEnglishCode(jaId, EN_IDS), `${jaId} shares an EN code`).toBe(true);
    }
  });

  it("still drops nothing and renames nothing for a Japanese-only code", () => {
    // The doctrine: a bare JA code wins where one exists. These must pass
    // through untouched -- R1-R4's keys are not this ruling's business.
    for (const jaId of ["S12a", "SV8a", "sv2a", "PMCG4", "s8b"]) {
      const key = jaSetKeyFor(jaId, EN_IDS);
      expect(key).toBe(slugCode(jaId));
      expect(key.startsWith("ja-")).toBe(false);
      expect(sharesEnglishCode(jaId, EN_IDS)).toBe(false);
    }
  });

  it("the 19 with a JA source are exactly the ambiguous codes", () => {
    // Not a coincidence, and #1959 says why: a code is ambiguous PRECISELY
    // because tcgdex serves a Japanese set under it, and the generator then
    // dropped that set. Same line, seen from the other side.
    const codes = JA_SETS_SHARING_AN_EN_CODE.map(([, c]) => c).sort();
    const ruledAmbiguous = Object.keys(japaneseVintageKeyRewrites())
      .filter((c) => AMBIGUOUS_MARKET_CODES.has(c)).sort();
    expect(codes).toEqual(ruledAmbiguous);
  });

  it("refuses a bare prefix and an empty id", () => {
    expect(jaSetKeyFor("", EN_IDS)).toBeNull();
    expect(jaSetKeyFor(null, EN_IDS)).toBeNull();
    expect(isRuledJapaneseVintageKey("ja-")).toBe(false);
  });
});
