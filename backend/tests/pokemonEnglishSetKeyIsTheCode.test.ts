// CF-THE-ENGLISH-SET-CODE-IS-THE-KEY (Drew, 2026-09-06).
//
// THE RULING. For an English Pokemon product the canonical setKey is the
// tcgdex set CODE — `sv08-5` for Prismatic Evolutions — and the normalized
// English NAME is an ALIAS of that code. The English half of
// CF-THE-JAPANESE-CODE-IS-THE-KEY, under the same standing doctrine:
// A RULED KEY MUST BE A normalizeSetKey FIXED POINT.
//
// WHAT THIS PINS, and why each half is load-bearing:
//
//   THE ALIAS RESOLVES. Every English name spelling normalizes to its code, so
//   the name-keyed and code-keyed halves of the pool can finally name each
//   other. Measured on this branch before the fix, 832 of the 1,497 alias keys
//   were fixed points of `normalizeSetKey` — one product, two spellings, two
//   pools, and neither able to reach the other (CF-ONE-CARD-ONE-ROW-ONE-POOL).
//
//   THE CODE IS A FIXED POINT. All 205 English codes were fixed points before
//   the change and must remain so after it: a rewrite that moved a code would
//   turn the ruling on itself.
//
//   THE JAPANESE RULING SURVIVES. Six spellings name different products in the
//   two markets, and the Japanese sale must still reach the Japanese code.
//
//   THE SPORTS VOCABULARY STOPS CLAIMING POKEMON. 35 names were being swallowed
//   by unanchored brand patterns into Panini and Leaf pools.
import { describe, it, expect } from "vitest";
import {
  normalizeSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { POKEMON_SET_ALIASES } from "../src/services/catalog/pokemonSetAliases.js";
import {
  POKEMON_EN_SET_CODES,
  POKEMON_PROMO_SET_CODES,
  POKEMON_JA_SET_CODES,
} from "../src/services/catalog/pokemonSetCodes.js";
import {
  pokemonEnglishSetKeyRewrites,
  ruledPokemonEnglishSetKey,
} from "../src/services/catalog/pokemonEnglishSetKeyRuling.js";

/** The market spellings Drew named, and the code each one IS. */
const MARKET_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ["Prismatic Evolutions", "sv08-5"],
  ["Scarlet & Violet Prismatic Evolutions", "sv08-5"],
  ["SV Prismatic Evolutions", "sv08-5"],
  ["Surging Sparks", "sv08"],
  ["Obsidian Flames", "sv03"],
  ["Evolving Skies", "swsh7"],
  ["Base Set", "base1"],
  ["Jungle", "base2"],
  ["Fossil", "base3"],
  ["Team Rocket", "base5"],
  ["Neo Genesis", "neo1"],
];

const slug = (s: string): string =>
  s.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

describe("CF-THE-ENGLISH-SET-CODE-IS-THE-KEY — the name resolves to the code", () => {
  // "SV Prismatic Evolutions" has no NAME alias — the alias table spells the
  // series out — so it is reached the way a title always is, through the
  // deriver, which reads the set name inside it. Both routes must land on the
  // same code, which is what makes the code canonical rather than merely
  // preferred.
  it.each(MARKET_SPELLINGS)("%s is %s", (name, code) => {
    const viaName = ruledPokemonEnglishSetKey(slug(name)) ?? normalizeSetKey(slug(name), "pokemon");
    const viaTitle = normalizeSetKey(inferSetKeyFromTitle(`2025 Pokemon ${name} Pikachu ex #123`), "pokemon");
    expect(viaTitle).toBe(code);
    if (POKEMON_SET_ALIASES[slug(name)]) expect(viaName).toBe(code);
  });

  // THE TWO DERIVERS MUST AGREE. `resolveSetKeyForSlug` is handed a setName the
  // caller already holds; `inferSetKeyFromTitle` has only the title. Where both
  // can read the set, they must land on the SAME code — two derivers
  // disagreeing about one product is the defect setKeyReconciliation exists for.
  //
  // "SV Prismatic Evolutions" is excluded on purpose: the abbreviation is not a
  // spelling the alias table carries, so the vendor path honestly cannot read
  // it and falls to a year-prefixed key the slug guard refuses. Absent beats
  // wrong. The TITLE path DOES read it (pinned above), which is the route that
  // shape actually arrives by.
  it("resolves the vendor setName path onto the same code as the title path", () => {
    for (const [name, code] of MARKET_SPELLINGS) {
      if (name === "SV Prismatic Evolutions") continue;
      expect(resolveSetKeyForSlug("pokemon", `2025 Pokemon ${name}`, 2025)).toBe(code);
    }
  });

  // THE DEFECT, NAMED. Every one of these was a fixed point before the ruling:
  // the deriver returned the name unchanged, so a row keyed by the name could
  // never join the catalog row keyed by the code.
  it("no longer leaves an English set name as its own key", () => {
    for (const n of ["prismatic-evolutions", "surging-sparks", "base-set", "jungle", "neo-genesis"]) {
      expect(normalizeSetKey(n, "pokemon")).not.toBe(n);
    }
  });
});

describe("a ruled key is a fixed point", () => {
  it("every English set code round-trips through normalizeSetKey unchanged", () => {
    const broken = Object.keys(POKEMON_EN_SET_CODES).filter((c) => normalizeSetKey(c) !== c);
    expect(broken).toEqual([]);
  });

  it("every English promo code round-trips unchanged", () => {
    const broken = Object.keys(POKEMON_PROMO_SET_CODES).filter((c) => normalizeSetKey(c) !== c);
    expect(broken).toEqual([]);
  });

  it("every code the ruling can EMIT is itself a fixed point", () => {
    const targets = [...new Set(Object.values(pokemonEnglishSetKeyRewrites()))];
    expect(targets.filter((c) => normalizeSetKey(c) !== c)).toEqual([]);
  });

  it("normalizeSetKey is idempotent on every ruled English name", () => {
    for (const name of Object.keys(pokemonEnglishSetKeyRewrites())) {
      const once = normalizeSetKey(name, "pokemon");
      expect(normalizeSetKey(once, "pokemon")).toBe(once);
    }
  });
});

describe("the Japanese rulings are intact", () => {
  it("keeps the ruled japanese-<code> rewrites (R2)", () => {
    expect(normalizeSetKey("japanese-sv2a")).toBe("sv2a");
    expect(normalizeSetKey("japanese-sv8a")).toBe("sv8a");
    expect(normalizeSetKey("japanese-s12a")).toBe("s12a");
    expect(normalizeSetKey("swsh12a")).toBe("s12a");
  });

  it("keeps the negative pins — EN swsh12 / swsh12tg are different products", () => {
    expect(normalizeSetKey("swsh12")).toBe("swsh12");
    expect(normalizeSetKey("swsh12tg")).toBe("swsh12tg");
  });

  it("keeps R1: the 1997 Japanese Rocket Gang key keeps its NAME", () => {
    expect(normalizeSetKey("1997-pokemon-japanese-rocket-gang")).toBe("pokemon-japanese-rocket-gang");
  });

  it("never emits a Japanese-only code from the English ruling", () => {
    const jaOnly = Object.values(pokemonEnglishSetKeyRewrites())
      .filter((c) => POKEMON_JA_SET_CODES[c] && !POKEMON_EN_SET_CODES[c]);
    expect(jaOnly).toEqual([]);
  });

  // THE BOUNDARY THE SHARED SPELLINGS FORCE. `black-bolt` is `sv10-5b` in
  // English and `sv11b` in Japanese — different prints, different markets,
  // different prices. A JAPANESE sale must still reach the Japanese code, and
  // it does because resolveSetKeyForSlug reads "japanese" from the setName and
  // answers BEFORE normalizeSetKey is ever consulted.
  it("routes a Japanese sale to the Japanese code and an English one to the English code", () => {
    expect(resolveSetKeyForSlug("pokemon", "2025 Pokemon Japanese Black Bolt", 2025)).toBe("sv11b");
    expect(resolveSetKeyForSlug("pokemon", "2025 Pokemon Black Bolt", 2025)).toBe("sv10-5b");
    expect(resolveSetKeyForSlug("pokemon", "2023 Pokemon Japanese Scarlet & Violet 151", 2023)).toBe("sv2a");
  });
});

// THE GATE. The English Pokemon vocabulary contains keys that are ORDINARY
// WORDS in a sports set name — `151`, `jungle`, `dragon`, `base-set` — so it
// may only be consulted by a caller that knows the row is Pokemon. Without
// this gate the fix would be the mirror image of the damage it repairs:
// pokemonSetAliases.test.ts already pins "aliases do NOT leak into other
// sports", and it is the test that caught this during development.
describe("the ruling is gated on sport", () => {
  it("does not touch a set name when no vertical is asserted", () => {
    expect(normalizeSetKey("151")).toBe("151");
    expect(normalizeSetKey("base-set")).toBe("base-set");
    expect(normalizeSetKey("jungle")).toBe("jungle");
  });

  it("does not touch a set name on a sports row", () => {
    expect(normalizeSetKey("151", "baseball")).toBe("151");
    expect(normalizeSetKey("base-set", "basketball")).toBe("base-set");
    expect(normalizeSetKey("jungle", "football")).toBe("jungle");
  });

  it("answers only for sport=pokemon", () => {
    expect(normalizeSetKey("151", "pokemon")).toBe("sv03-5");
    expect(normalizeSetKey("base-set", "pokemon")).toBe("base1");
    expect(normalizeSetKey("jungle", "pokemon")).toBe("base2");
  });

  // THE CODES ARE FIXED POINTS WITH OR WITHOUT THE SPORT, which is what lets a
  // stored pool key survive a sport-blind re-derivation. Only the NAME side of
  // the ruling needs the gate.
  it("keeps every English code a fixed point even with no sport", () => {
    const broken = Object.keys(POKEMON_EN_SET_CODES).filter(
      (c) => normalizeSetKey(c) !== c || normalizeSetKey(c, "pokemon") !== c,
    );
    expect(broken).toEqual([]);
  });
});

describe("a standing ruling is not re-litigated by a table load", () => {
  // `ultra-prism` is `final` in setKeyReconciliation — a verdict taken against
  // the real catalog. The alias table would map it to sm5; the ruling wins.
  it("leaves a key the reconciliation already rules on alone", () => {
    expect(ruledPokemonEnglishSetKey("ultra-prism")).toBeNull();
    expect(normalizeSetKey("ultra-prism", "pokemon")).toBe("ultra-prism");
  });

  it("never rewrites one set code onto another", () => {
    const codeKeys = Object.keys(pokemonEnglishSetKeyRewrites())
      .filter((k) => POKEMON_EN_SET_CODES[k] || POKEMON_PROMO_SET_CODES[k] || POKEMON_JA_SET_CODES[k]);
    expect(codeKeys).toEqual([]);
  });
});

describe("the sports vocabulary no longer claims a Pokemon set", () => {
  // MEASURED, not supposed: 35 alias spellings were collapsing into Panini and
  // Leaf pools, and the census found ~2,600 live pool rows sitting in them.
  const CROSS_VERTICAL: ReadonlyArray<readonly [string, string]> = [
    ["obsidian-flames", "sv03"],
    ["scarlet-violet-obsidian-flames", "sv03"],
    ["crown-zenith", "swsh12-5"],
    ["crown-zenith-galarian-gallery", "swsh12-5gg"],
    ["ancient-origins", "xy7"],
    ["xy-ancient-origins", "xy7"],
    ["firered-leafgreen", "ex6"],
    ["ex-firered-leafgreen", "ex6"],
  ];

  it.each(CROSS_VERTICAL)("%s is %s, not a Panini/Leaf product", (name, code) => {
    expect(normalizeSetKey(name, "pokemon")).toBe(code);
  });

  it("no ruled English name resolves into a sports brand namespace", () => {
    const leaked = Object.keys(pokemonEnglishSetKeyRewrites())
      .filter((k) => /^(panini|topps|leaf|bowman|donruss|upper-deck|fleer)(-|$)/.test(normalizeSetKey(k, "pokemon")));
    expect(leaked).toEqual([]);
  });

  // THE SPORTS SIDE IS UNHARMED. The ruling is exact-token, so a Panini
  // product whose name merely contains a word a Pokemon set also uses keeps
  // its own key.
  it("leaves the sports vocabulary's own fixed points alone", () => {
    expect(normalizeSetKey("panini-obsidian")).toBe("panini-obsidian");
    expect(normalizeSetKey("panini-zenith")).toBe("panini-zenith");
    expect(normalizeSetKey("panini-origins")).toBe("panini-origins");
    expect(normalizeSetKey("leaf")).toBe("leaf");
    expect(normalizeSetKey("leaf-metal")).toBe("leaf-metal");
    expect(normalizeSetKey("panini-prizm")).toBe("panini-prizm");
    expect(normalizeSetKey("topps-chrome")).toBe("topps-chrome");
  });
});

// THE MUTATION PINS. Each asserts a property that a plausible edit breaks —
// they are the tests that fail when the wiring is removed, not merely when the
// data changes.
describe("mutation pins", () => {
  it("REMOVE ONE ALIAS -> RED: the table is the source of the answer", () => {
    // If normalizeSetKey were answering from somewhere else, a name absent
    // from the table would still resolve to a code. This passes only because
    // the table IS the authority.
    expect(ruledPokemonEnglishSetKey("prismatic-evolutions")).toBe("sv08-5");
    expect(ruledPokemonEnglishSetKey("a-set-that-does-not-exist")).toBeNull();
    expect(normalizeSetKey("a-set-that-does-not-exist")).toBe("a-set-that-does-not-exist");
  });

  it("DELETE THE CALL FROM normalizeSetKey -> RED", () => {
    // The one assertion that fails if `ruledPokemonEnglishSetKey` is unwired:
    // every ruled name must come back as its code THROUGH normalizeSetKey, not
    // merely through the resolver called directly.
    const rewrites = pokemonEnglishSetKeyRewrites();
    const unresolved = Object.entries(rewrites).filter(([name, code]) => normalizeSetKey(name, "pokemon") !== code);
    expect(unresolved).toEqual([]);
  });

  // The KEY count is lower than the alias table's 1,497 and that is the design,
  // not a shortfall: the year-prefixed spellings (`2014-xy`,
  // `2023-pokemon-obsidian-flames`) COLLAPSE onto their bare forms, because
  // `normalizeSetKey` strips the year before it asks. What must be complete is
  // the DESTINATION side — every English expansion the table knows has to be
  // reachable — so that is what this pins.
  it("the ruling reaches every English expansion in the alias table", () => {
    const rewrites = pokemonEnglishSetKeyRewrites();
    const reachable = new Set(Object.values(rewrites));
    const wanted = new Set(
      Object.entries(POKEMON_SET_ALIASES)
        .filter(([, code]) => !POKEMON_JA_SET_CODES[code] || POKEMON_EN_SET_CODES[code])
        .map(([, code]) => code),
    );
    // EVERY English expansion is reachable, sm5 included — and sm5 is the
    // interesting one. Its BARE spelling `ultra-prism` is refused here because
    // setKeyReconciliation already rules on that key, but the set is still
    // reached by its other spellings (`sm-ultra-prism`,
    // `pokemon-sun-moon-ultra-prism`). Deferring to a standing ruling costs one
    // SPELLING, never the SET.
    const unreachable = [...wanted].filter((c) => !reachable.has(c));
    expect(unreachable).toEqual([]);
    expect(reachable.has("sm5")).toBe(true);
    expect(ruledPokemonEnglishSetKey("ultra-prism")).toBeNull();
    expect(reachable.size).toBeGreaterThanOrEqual(200);
    expect(Object.keys(rewrites).length).toBeGreaterThan(800);
  });
});
