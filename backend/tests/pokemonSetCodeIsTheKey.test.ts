// CF-THE-SET-CODE-IS-THE-KEY (2026-09-05).
//
// Sellers write the set CODE as often as the set NAME. The unknown-setKey
// census (#1796, backend/docs/reports/unknown-setkey-2026-09-05.md) measured
// the Pokemon half of the ~500k "needs vocabulary" bucket and found it is
// overwhelmingly promo and code spellings that no name alias can see:
//
//     mep en-me black star           2,877 rows  -> mep
//     sv black star promos           1,884       -> svp
//     japanese m3-nullifying zero    1,780       -> m3
//     japanese m5-abyss eye special  1,661       -> m5
//     swsh black star promo          1,631       -> swshp
//     sm black star promo            1,483       -> smp
//     svp en-sv black star           1,216       -> svp
//     japanese m2a-mega dream ex     1,142       -> m2a
//
// The tests below are in three groups, and the SECOND and THIRD are the
// load-bearing ones. The first shows the codes resolve; the second pins the
// boundaries the resolution must never cross (a sports title, an ambiguous
// market code, a card number wearing a code's clothes); the third is the
// mutation check -- it fails if the resolver call is deleted, which is the
// regression that would silently restore the defect.
import { describe, it, expect } from "vitest";
import {
  inferSetKeyFromTitle,
  resolveEnglishPokemonSetFromTitle,
  resolveJapanesePokemonSetCodeFromTitle,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import {
  POKEMON_EN_SET_CODES,
  POKEMON_PROMO_SET_CODES,
  POKEMON_JA_SET_CODES,
  AMBIGUOUS_MARKET_CODES,
} from "../src/services/catalog/pokemonSetCodes.js";

/** The parser's answer as the ingest path stores it: normalized. */
const key = (title: string): string => normalizeSetKey(inferSetKeyFromTitle(title));

describe("CF-THE-SET-CODE-IS-THE-KEY — the census spellings resolve", () => {
  it("English promo codes, which are the census's largest Pokemon rows", () => {
    expect(key("2025 Pokemon SVP EN-SV Black Star Promo Charizard ex #SVP123")).toBe("svp");
    expect(key("2022 Pokemon SWSH Black Star Promo Pikachu SWSH270")).toBe("swshp");
    expect(key("2019 Pokemon SM Black Star Promo Mewtwo SM190")).toBe("smp");
    expect(key("2026 Pokemon MEP EN-ME Black Star Promo Gengar")).toBe("mep");
  });

  it("Japanese codes written as the seller writes them", () => {
    // The census's shape is `<code>-<romanized name>`: "japanese m5-abyss eye".
    expect(key("2026 Pokemon Japanese M5-Abyss Eye Special Art Rare")).toBe("m5");
    expect(key("2026 Pokemon Japanese M3-Nullifying Zero Art Rare")).toBe("m3");
    expect(key("2025 Pokemon Japanese M2a-Mega Dream ex Special")).toBe("m2a");
  });

  it("a set code beats no key at all for a title the NAME table cannot read", () => {
    // The whole point: before this, each of these returned "Unknown" and the
    // deriver refused the row.
    for (const t of [
      "2025 Pokemon SVP EN-SV Black Star Promo Umbreon",
      "2026 Pokemon Japanese M5-Abyss Eye Special",
    ]) {
      expect(key(t)).not.toBe("unknown");
      expect(key(t)).not.toBe("");
      expect(key(t).startsWith("bowman")).toBe(false);
    }
  });

  it("the NAME still wins over the code when both are present", () => {
    // The name is the more specific signal and every alias was already ruled.
    expect(key("2025 Pokemon Prismatic Evolutions Umbreon ex 161/131")).toBe("sv08-5");
  });
});

describe("CF-THE-SET-CODE-IS-THE-KEY — the boundaries it must not cross", () => {
  it("a SPORTS title never resolves through the Pokemon code map", () => {
    // THE MUTATION CHECK THE ASK NAMES. The code map contains `sp` (Sample),
    // `rc` (Radiant Collection), `lc`, `g1`, `a1` -- tokens that appear in
    // sports titles as card numbers and abbreviations all the time. The
    // Pokemon branch is gated on the title naming Pokemon, so none of these
    // may reach it. Each title below carries a token that IS a Pokemon set
    // code, and each must answer with its own sports product.
    expect(key("2024 Topps Chrome Update Paul Skenes #USC1")).toBe("topps-chrome");
    expect(key("2023 Topps Series 1 Aaron Judge SP #99")).not.toBe("sp");
    expect(key("2021 Panini Prizm RC Rookie Card Ja Morant #RC1")).not.toBe("rc");
    expect(key("2022 Bowman Chrome LC Luis Campusano #BCP150")).not.toBe("lc");
    expect(key("2020 Panini Select G1 Justin Herbert #G1")).not.toBe("g1");
    expect(key("2019 Topps A1 Mike Trout #A1")).not.toBe("a1");
    // And the resolver itself refuses a sports title outright.
    expect(resolveEnglishPokemonSetFromTitle("2024 Topps Chrome SP Update #USC1")).toBeNull();
    expect(resolveJapanesePokemonSetCodeFromTitle("2024 Topps Chrome SP Update #USC1")).toBeNull();
  });

  it("a sports title that ALSO says promo / black star is still sports", () => {
    // The promo branch is the loosest rule in the change -- it reads an ERA
    // prefix (`swsh`, `sm`, `bw`, `np`) once the title says "promo" or "black
    // star". Those era tokens are live in sports titles too, so this is the
    // combination most likely to misfire, and it is pinned rather than argued.
    // Every one is verified against the built parser.
    expect(key("2024 Topps Chrome Promo SP Aaron Judge #99")).toBe("topps-chrome");
    expect(key("2023 Panini Prizm Black Star Promo Wembanyama")).toBe("panini-prizm");
    expect(key("2021 Bowman Chrome BW Promo Julio Rodriguez")).toBe("bowman-chrome");
    expect(key("2019 Topps NP Promo Mike Trout")).toBe("topps");
  });

  it("an AMBIGUOUS market code is refused from a bare code", () => {
    // 24 ids name DIFFERENT products in the two markets -- EN sm1 is "Sun &
    // Moon", JA sm1 is "Collection Sun". A bare code cannot say which, so the
    // resolver declines rather than pool one market into the other.
    expect(AMBIGUOUS_MARKET_CODES.has("sm1")).toBe(true);
    expect(AMBIGUOUS_MARKET_CODES.has("sv10")).toBe(true);
    expect(resolveEnglishPokemonSetFromTitle("Pokemon SM1 Pikachu holo")).toBeNull();
    expect(resolveEnglishPokemonSetFromTitle("Pokemon XY2 Charizard")).toBeNull();
    // ...and no ambiguous code is in the Japanese-only table, by construction.
    for (const c of AMBIGUOUS_MARKET_CODES) {
      expect(POKEMON_JA_SET_CODES[c]).toBeUndefined();
    }
  });

  it("a SHORT code needs promo context, because it is usually a card number", () => {
    // `svp` is a set; "SVP" next to a card number in a non-promo title is not
    // enough on its own. The floor is: <=3 chars only when the title says
    // promo / black star.
    expect(resolveEnglishPokemonSetFromTitle("Pokemon Charizard np 12")).toBeNull();
    expect(resolveEnglishPokemonSetFromTitle("Pokemon Nintendo Black Star Promo np 12")).toBe("np");
  });

  it("a degenerate title refuses rather than guesses, and never throws", () => {
    // CF-UNKNOWN-IS-ALSO-A-GUESS. A title with the word "Pokemon" and nothing
    // else must NOT be handed the first short code that happens to match.
    // "Pokemon 151" is the sharpest case: `151` is a real English set name
    // (sv03-5) AND the commonest kind of card number in a Pokemon title, and
    // the >=4-char alias floor is what keeps it refused.
    for (const t of ["", "   ", "Pokemon", "pokemon japanese", "POKEMON---",
      "2025 Pokemon", "Pokemon 151", "pokemon sv"]) {
      expect(inferSetKeyFromTitle(t)).toBe("Unknown");
    }
    // Null and undefined reach this function from rows with no title at all.
    expect(inferSetKeyFromTitle(null as unknown as string)).toBe("Unknown");
    expect(inferSetKeyFromTitle(undefined as unknown as string)).toBe("Unknown");
  });

  it("a NON-Pokemon TCG title is still untouched", () => {
    // One Piece / Yu-Gi-Oh / MTG / Lorcana gained NO vocabulary in this change
    // -- CF-POKEMON-TCG-EXPANSION-PARKED still parks that vertical.
    expect(key("2024 Yu-Gi-Oh! Rage of the Abyss Blue-Eyes White Dragon")).toBe("unknown");
    expect(key("2023 Magic The Gathering Lord of the Rings One Ring")).toBe("unknown");
    expect(key("2025 One Piece OP12-Legacy of the Master Luffy")).toBe("unknown");
    expect(key("2024 Lorcana Rise of the Floodborn Elsa")).toBe("unknown");
  });

  it("a Japanese title never reaches the ENGLISH name vocabulary", () => {
    // `151` is sv03-5 in English and sv2a in Japanese. The English resolver
    // must keep declining Japanese titles -- this is the pin #1801 wrote and
    // the Japanese CODE lane must not weaken it.
    expect(resolveEnglishPokemonSetFromTitle("2023 Pokemon Japanese Scarlet & Violet 151 Charizard ex")).toBeNull();
    expect(resolveEnglishPokemonSetFromTitle("2025 Pokemon Japanese Destined Rivals Mewtwo ex")).toBeNull();
  });

  it("an ENGLISH title never reaches the Japanese CODE table", () => {
    expect(resolveJapanesePokemonSetCodeFromTitle("2026 Pokemon M5 Abyss Eye")).toBeNull();
    expect(resolveJapanesePokemonSetCodeFromTitle("2025 Pokemon Prismatic Evolutions Umbreon")).toBeNull();
  });
});

describe("CF-A-RULED-KEY-IS-A-FIXED-POINT — data-driven over the whole map", () => {
  // THE PIN THE ASK ASKS FOR, and it is data-driven rather than a list: EVERY
  // key the map can emit must survive normalizeSetKey unchanged, or the pool
  // can never name the checklist card_catalog already holds under it. A new
  // tcgdex set that collides with a sports pattern fails here the day it is
  // generated, which is the point -- a hand-written list would not.
  const emittable = [
    ...Object.keys(POKEMON_EN_SET_CODES),
    ...Object.keys(POKEMON_PROMO_SET_CODES),
    ...Object.keys(POKEMON_JA_SET_CODES),
  ];

  it("the map is the size the generator reported", () => {
    expect(Object.keys(POKEMON_EN_SET_CODES).length).toBe(205);
    expect(Object.keys(POKEMON_PROMO_SET_CODES).length).toBe(13);
    expect(Object.keys(POKEMON_JA_SET_CODES).length).toBe(160);
    expect(AMBIGUOUS_MARKET_CODES.size).toBe(24);
  });

  it("every emittable code is a normalizeSetKey fixed point", () => {
    const broken = emittable.filter((c) => normalizeSetKey(c) !== c);
    // Named, not just counted: a failure here must say WHICH key drifted and
    // what it drifted to, or the next reader has to re-derive the list.
    expect(broken.map((c) => `${c} -> ${normalizeSetKey(c)}`)).toEqual([]);
  });

  it("no emittable code collides with a sports product key", () => {
    // A code that normalizes to a sports key would pool Pokemon sales into a
    // sports pool -- the `one piece op12-legacy -> panini-legacy` failure the
    // census warned about, which is exactly why no TCG vocabulary was added
    // to the sports normalizer.
    for (const c of emittable) {
      const n = normalizeSetKey(c);
      expect(n.startsWith("panini")).toBe(false);
      expect(n.startsWith("topps")).toBe(false);
      expect(n.startsWith("bowman")).toBe(false);
      expect(n.startsWith("donruss")).toBe(false);
      expect(n.startsWith("upper-deck")).toBe(false);
    }
  });
});

describe("CF-THE-SET-CODE-IS-THE-KEY — the mutation check", () => {
  // If the code resolver is deleted from resolveEnglishPokemonSetFromTitle or
  // from the Japanese branch of inferSetKeyFromTitle, these fail. That deletion
  // is the exact regression that produced the defect this PR fixes, and a test
  // suite that only asserted the happy path would not notice it.
  it("the English code lane is reachable from inferSetKeyFromTitle", () => {
    expect(inferSetKeyFromTitle("2025 Pokemon SVP EN-SV Black Star Promo Umbreon")).not.toBe("Unknown");
  });
  it("the Japanese code lane is reachable from inferSetKeyFromTitle", () => {
    expect(inferSetKeyFromTitle("2026 Pokemon Japanese M5-Abyss Eye Special")).not.toBe("Unknown");
  });
});
