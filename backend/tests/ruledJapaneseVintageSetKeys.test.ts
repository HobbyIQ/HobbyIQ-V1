import { describe, it, expect } from "vitest";
import {
  normalizeSetKey,
  canonicalRuledSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { JAPANESE_POKEMON_SET_ALIASES } from "../src/services/catalog/japanesePokemonAliases.js";
import {
  POKEMON_EN_SET_CODES,
  POKEMON_JA_SET_CODES,
  POKEMON_PROMO_SET_CODES,
  AMBIGUOUS_MARKET_CODES,
} from "../src/services/catalog/pokemonSetCodes.js";
import {
  japaneseVintageKeyRewrites,
  ruledJapaneseVintageKeys,
  ruledJapaneseVintageSetKey,
  ruledJapaneseSetAliases,
  isRuledJapaneseVintageKey,
  jaKeyForEnglishCode,
} from "../src/services/catalog/japaneseVintageSetKeyRuling.js";

// CF-THE-JAPANESE-VINTAGE-SET-GETS-ITS-OWN-KEY (Drew, 2026-09-07, R5).
//
// The 38 Japanese sets whose alias resolves to a code the ENGLISH table owns
// get a DISTINCT key, `ja-<code>`. #1948 measured them and correctly left them
// alone: the key space could not express the split. This is the key space
// learning to express it, and these are the pins that hold the boundary.

/** The six spellings the ruling itself names. */
const RULED_EXAMPLES: Readonly<Record<string, string>> = {
  jungle: "ja-base2",
  "dark-rush": "ja-bw4",
  "wind-from-the-sea": "ja-ecard3",
  "leaders-x27-stadium": "ja-gym1",
  "challenge-from-the-darkness": "ja-gym2",
  "base-expansion-pack": "ja-ecard1",
};

describe("R5 scope: exactly the 38 shared-code destinations", () => {
  it("covers 38 English codes, no more and no fewer", () => {
    expect(Object.keys(japaneseVintageKeyRewrites())).toHaveLength(38);
    expect(ruledJapaneseVintageKeys()).toHaveLength(38);
  });

  it("every covered code is an ENGLISH code the JAPANESE table does not own", () => {
    // Both halves of the scope test, restated as an assertion over the result.
    // This is what keeps the doctrine "a bare JA code wins where one exists".
    for (const code of Object.keys(japaneseVintageKeyRewrites())) {
      expect(POKEMON_EN_SET_CODES[code], `${code} must be an English code`).toBeTruthy();
      expect(POKEMON_JA_SET_CODES[code], `${code} must NOT have its own JA code`).toBeFalsy();
    }
  });

  it("every covered code is a destination the JA alias table actually names", () => {
    const dests = new Set(Object.values(JAPANESE_POKEMON_SET_ALIASES));
    for (const code of Object.keys(japaneseVintageKeyRewrites())) {
      expect(dests.has(code), `${code} must be a JA alias destination`).toBe(true);
    }
  });

  it("the key is the code with a ja- prefix, mechanically", () => {
    for (const [code, key] of Object.entries(japaneseVintageKeyRewrites())) {
      expect(key).toBe(`ja-${code}`);
      expect(key).toBe(jaKeyForEnglishCode(code));
    }
  });

  it("names the six spellings the ruling calls out", () => {
    for (const [alias, key] of Object.entries(RULED_EXAMPLES)) {
      const code = JAPANESE_POKEMON_SET_ALIASES[alias];
      expect(code, `alias ${alias} must exist`).toBeTruthy();
      expect(ruledJapaneseVintageSetKey(code)).toBe(key);
    }
  });

  // THE PROMO REFUSAL. Seven JA alias destinations are English PROMO lines
  // (bwp, dpp, miscp, smp, svp, swshp, xyp). They are promo LINES, not dated
  // set printings, and the Japanese promo lines have their own aliases
  // already — so ruling one would mint a key for a boundary nobody drew.
  it("refuses the seven English PROMO destinations", () => {
    for (const promo of ["bwp", "dpp", "miscp", "smp", "svp", "swshp", "xyp"]) {
      expect(POKEMON_PROMO_SET_CODES[promo], `${promo} is a promo code`).toBeTruthy();
      expect(ruledJapaneseVintageSetKey(promo)).toBeNull();
      expect(japaneseVintageKeyRewrites()[promo]).toBeUndefined();
    }
  });

  // THE 19 AMBIGUOUS CODES ARE IN SCOPE, and this is deliberate: ambiguity is
  // a property of a BARE code in a title, not of a row that states its market.
  it("includes the 19 ambiguous codes — a stated market is not an ambiguous one", () => {
    const covered = Object.keys(japaneseVintageKeyRewrites());
    const ambiguous = covered.filter((c) => AMBIGUOUS_MARKET_CODES.has(c));
    expect(ambiguous).toHaveLength(19);
    for (const c of ["neo1", "sm10", "xy2", "sv10"]) expect(ambiguous).toContain(c);
  });
});

describe("R5: every ruled key is a normalizeSetKey FIXED POINT", () => {
  // THE STANDING REQUIREMENT on any ruled key. 187 of the 188 vocabulary
  // patterns are unanchored, so a short token is exactly what a longer
  // unanchored rule can capture. If one ever does, this fails.
  it("all 38 survive normalizeSetKey unchanged", () => {
    for (const key of ruledJapaneseVintageKeys()) {
      expect(normalizeSetKey(key), `${key} must be a fixed point`).toBe(key);
      expect(canonicalRuledSetKey(key), `${key} must be canonical`).toBe(key);
    }
  });

  it("all 38 survive the Pokemon-gated normalizeSetKey too", () => {
    // The sport-aware form consults the ENGLISH ruling, which must not claim
    // a ja- key back onto its English code.
    for (const key of ruledJapaneseVintageKeys()) {
      expect(normalizeSetKey(key, "pokemon"), `${key} under sport=pokemon`).toBe(key);
    }
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    for (const key of ruledJapaneseVintageKeys()) {
      expect(normalizeSetKey(normalizeSetKey(key))).toBe(key);
    }
  });
});

describe("R5: the ENGLISH codes are untouched", () => {
  // THE NEGATIVE HALF. Every one of these 38 English codes is a LIVE key
  // holding live English rows. If the ruling ever reached them, 38 English
  // pools would be renamed onto Japanese ones — the exact failure R3 and R4
  // withheld their rewrites to avoid.
  it("all 38 English codes remain fixed points", () => {
    for (const code of Object.keys(japaneseVintageKeyRewrites())) {
      expect(normalizeSetKey(code), `EN ${code} must not move`).toBe(code);
      expect(canonicalRuledSetKey(code), `EN ${code} must not move`).toBe(code);
    }
  });

  it("an ENGLISH title still mints the bare English code", () => {
    const cases: [string, number, string][] = [
      ["1999 Pokemon Jungle", 1999, "base2"],
      ["1999 Pokemon Fossil", 1999, "base3"],
      ["2000 Pokemon Gym Heroes", 2000, "gym1"],
      ["2000 Pokemon Gym Challenge", 2000, "gym2"],
      ["2002 Pokemon Expedition Base Set", 2002, "ecard1"],
      ["2003 Pokemon Skyridge", 2003, "ecard3"],
      ["2012 Pokemon Next Destinies", 2012, "bw4"],
    ];
    for (const [title, year, want] of cases) {
      expect(resolveSetKeyForSlug("pokemon", title, year), title).toBe(want);
    }
  });

  it("no ruled key collides with any existing English or Japanese code", () => {
    for (const key of ruledJapaneseVintageKeys()) {
      expect(POKEMON_EN_SET_CODES[key]).toBeFalsy();
      expect(POKEMON_JA_SET_CODES[key]).toBeFalsy();
      expect(POKEMON_PROMO_SET_CODES[key]).toBeFalsy();
    }
  });
});

describe("R5: the mint lands Japanese vintage sales on the ja- keys", () => {
  it("a Japanese vendor title resolves to the ruled key", () => {
    const cases: [string, number, string][] = [
      ["1997 Pokemon Japanese Jungle", 1997, "ja-base2"],
      ["1997 Pokemon Japanese Mystery of the Fossils", 1997, "ja-base3"],
      ["1999 Pokemon Japanese Challenge from the Darkness", 1999, "ja-gym2"],
      ["2001 Pokemon Japanese Base Expansion Pack", 2001, "ja-ecard1"],
      ["2002 Pokemon Japanese The Town on No Map", 2002, "ja-ecard2"],
      ["2002 Pokemon Japanese Wind from the Sea", 2002, "ja-ecard3"],
      ["2012 Pokemon Japanese Dark Rush", 2012, "ja-bw4"],
      ["2013 Pokemon Japanese Megalo Cannon", 2013, "ja-bw9"],
      ["2007 Pokemon Japanese Space-Time Creation", 2007, "ja-dp1"],
      ["2020 Pokemon Japanese Rebellion Crash", 2020, "ja-swsh2"],
      ["2025 Pokemon Japanese Glory of Team Rocket", 2025, "ja-sv10"],
    ];
    for (const [title, year, want] of cases) {
      expect(resolveSetKeyForSlug("pokemon", title, year), title).toBe(want);
    }
  });

  it("the JA set and its EN namesake are DIFFERENT keys, every time", () => {
    // One product, two markets, two pools — CF-ONE-CARD-ONE-ROW-ONE-POOL read
    // the other way round: two cards must never share one.
    const pairs: [string, string, number][] = [
      ["1997 Pokemon Japanese Jungle", "1999 Pokemon Jungle", 1999],
      ["1999 Pokemon Japanese Challenge from the Darkness", "2000 Pokemon Gym Challenge", 2000],
      ["2002 Pokemon Japanese Wind from the Sea", "2003 Pokemon Skyridge", 2003],
    ];
    for (const [ja, en, year] of pairs) {
      const jaKey = resolveSetKeyForSlug("pokemon", ja, year);
      const enKey = resolveSetKeyForSlug("pokemon", en, year);
      expect(jaKey).not.toBe(enKey);
      expect(jaKey).toMatch(/^ja-/);
    }
  });

  it("the ruled alias view rewrites only the 38, carrying the rest through", () => {
    const ruled = ruledJapaneseSetAliases();
    const rewrites = japaneseVintageKeyRewrites();
    expect(Object.keys(ruled)).toHaveLength(Object.keys(JAPANESE_POKEMON_SET_ALIASES).length);
    let moved = 0;
    for (const [alias, code] of Object.entries(JAPANESE_POKEMON_SET_ALIASES)) {
      if (rewrites[code]) { expect(ruled[alias]).toBe(`ja-${code}`); moved++; }
      else expect(ruled[alias], alias).toBe(code);
    }
    // 39 aliases across 38 codes — neo1 is named by two spellings.
    expect(moved).toBe(39);
  });
});

describe("R5: R1-R4 and the bare Japanese codes are untouched", () => {
  // THE DOCTRINE PIN. "JA = bare JA code where one exists" — so a set that
  // already has a real Japanese code must never be renamed by this ruling.
  it("no set with its own JA code enters the map", () => {
    for (const code of Object.keys(POKEMON_JA_SET_CODES)) {
      expect(ruledJapaneseVintageSetKey(code), `${code} has its own JA code`).toBeNull();
    }
    // AND THE 102 JA-ONLY DESTINATIONS ARE THE POPULATION THAT PROVES IT.
    // s12a, s12, sv2a, sv8a and the nine R4 codes are all among them: every
    // one is a JA alias destination, and not one may be rewritten.
    const jaOnlyDestinations = [...new Set(Object.values(JAPANESE_POKEMON_SET_ALIASES))]
      .filter((c) => POKEMON_JA_SET_CODES[c]);
    expect(jaOnlyDestinations.length).toBeGreaterThanOrEqual(100);
    for (const c of ["s12a", "s12", "sv2a", "sv8a", "s8", "s9", "s11", "s8b"]) {
      expect(jaOnlyDestinations, `${c} is a JA alias destination`).toContain(c);
      expect(ruledJapaneseVintageSetKey(c), `${c} must not be rewritten`).toBeNull();
      expect(ruledJapaneseSetAliases()["vstar-universe"]).toBe("s12a");
    }
  });

  // THE SCOPE CLAUSE, PINNED AS A RULE RATHER THAN AS TODAY'S DATA.
  //
  // `!POKEMON_JA_SET_CODES[code]` is DEFENSIVE on the tables as committed: the
  // generator drops a Japanese set whose id an English set owns
  // (`if (enByCode.has(code)) continue`), so no code is in both tables and the
  // clause excludes nothing today. It is kept because that generator invariant
  // is the ONLY thing making it redundant, and a table regenerated under a
  // changed rule would otherwise silently rename a set that has a real JA code
  // -- the one thing the doctrine forbids. This asserts the invariant itself,
  // so the day it stops holding this fails rather than the ruling widening.
  it("the two code tables are disjoint — the clause guards a generator invariant", () => {
    const inBoth = Object.keys(POKEMON_JA_SET_CODES).filter((c) => POKEMON_EN_SET_CODES[c]);
    expect(inBoth, "a code in BOTH tables would make the JA-code clause load-bearing").toEqual([]);
  });

  it("the R1-R4 ruled keys still resolve exactly as they did", () => {
    const cases: [string, number, string][] = [
      ["2022 Pokemon Japanese Sword & Shield VSTAR Universe", 2022, "s12a"],
      ["2022 Pokemon Japanese Sword & Shield Paradigm Trigger", 2022, "s12"],
      ["1997 Pokemon Japanese Rocket Gang", 1997, "japanese-rocket-gang"],
      ["2021 Pokemon Japanese Fusion Arts", 2021, "s8"],
      ["2022 Pokemon Japanese Lost Abyss", 2022, "s11"],
      ["2022 Pokemon Japanese Star Birth", 2022, "s9"],
      ["2021 Pokemon Japanese VMAX Climax", 2021, "s8b"],
    ];
    for (const [title, year, want] of cases) {
      expect(resolveSetKeyForSlug("pokemon", title, year), title).toBe(want);
    }
  });

  it("the three EN swsh sets R4 withheld are still English", () => {
    expect(resolveSetKeyForSlug("pokemon", "2021 Pokemon Sword & Shield Fusion Strike", 2021)).toBe("swsh8");
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Sword & Shield Lost Origin", 2022)).toBe("swsh11");
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Sword & Shield Brilliant Stars", 2022)).toBe("swsh9");
    expect(resolveSetKeyForSlug("pokemon", "2022 Pokemon Sword & Shield Silver Tempest", 2022)).toBe("swsh12");
  });
});

describe("R5: isRuledJapaneseVintageKey is exact-token", () => {
  it("accepts the 38 and nothing that merely starts ja-", () => {
    for (const key of ruledJapaneseVintageKeys()) expect(isRuledJapaneseVintageKey(key)).toBe(true);
    // The prefix alone is NOT the rule — this is what keeps the market guard
    // from reading an arbitrary sports key as Japanese.
    for (const near of ["ja-", "ja-nonesuch", "ja", "japanese-rocket-gang", "base2", "ja-base2-extra", ""]) {
      expect(isRuledJapaneseVintageKey(near), near).toBe(false);
    }
  });

  it("is case and whitespace tolerant", () => {
    expect(isRuledJapaneseVintageKey(" JA-BASE2 ")).toBe(true);
    expect(ruledJapaneseVintageSetKey("BASE2")).toBe("ja-base2");
    expect(ruledJapaneseVintageSetKey("")).toBeNull();
  });
});
