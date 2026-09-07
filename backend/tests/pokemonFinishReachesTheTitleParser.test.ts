// ---------------------------------------------------------------------------
// pokemonFinishReachesTheTitleParser.test.ts
//
// CF-A-FINISH-IS-A-CARD-LINE, AT THE TITLE PARSER (Drew, 2026-09-07).
//
// #1935 minted the finish rows and #1937 folded the five slug spellings onto
// two canonical tokens, and NEITHER moved the pools -- because
// `parseListingIdentity` answered "Base" on titles that state the finish in
// words. #1937 proved it by running a 600-row sample through the rematch
// classifier once on main and once with the fold and getting byte-for-byte
// identical output: 150/150 CONFLICT, 0 writable, on every token.
//
// This file pins the parser fix that finally reads them. Three things are
// asserted, and the third is the one that keeps this honest:
//
//   1. THE FINISH IS READ, across every era and every market spelling.
//   2. SPORTS ARE UNTOUCHED -- "Holo", "Foil" and "Reverse" are ordinary words
//      in a sports title and every one of them must keep its old answer.
//   3. THE VOCABULARY IS ONE VOCABULARY. `src/` cannot import a `scripts/`
//      `.cjs`, so the table is mirrored -- and pinned EQUAL in both directions
//      against `scripts/lib/pokemon-finish-vocab.cjs`, which is what the mint
//      lane writes rows at. A mirror nothing compares is a second source of
//      truth; a mirror a test compares is a cache.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { createRequire } from "node:module";
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import {
  pokemonFinishFromTitle,
  __FINISH_TOKENS_FOR_TEST,
  __FINISH_DISPLAY_FOR_TEST,
  __TITLE_SPELLING_ALIASES_FOR_TEST,
} from "../src/services/portfolioiq/pokemonFinishFromTitle.js";
import { normalizeParallel, foldPokemonFinishToken } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const require_ = createRequire(__filename);
const VOCAB = require_(join(__dirname, "..", "scripts", "lib", "pokemon-finish-vocab.cjs")) as {
  FINISH_TOKENS: Readonly<Record<string, string>>;
  FINISH_DISPLAY: Readonly<Record<string, string>>;
};

const parallelOf = (title: string): string => parseListingIdentity(title).parallel;

// ---------------------------------------------------------------------------
// 1. THE FINISH IS READ -- 25 real title shapes across every era.
// ---------------------------------------------------------------------------

/**
 * Real market title shapes, spanning WotC (1999-2003), EX (2003-2007), DP/Pt,
 * BW/XY, SM, SWSH and SV -- plus the two vendor suffix conventions the pool
 * actually carries: eBay's trailing words and TCGplayer's " - Holofoil".
 *
 * Every expectation is a `FINISH_DISPLAY` name, because that is what the mint
 * lane writes: the parser's answer and the catalog row's own `parallel` are
 * then the SAME STRING, and a row is looked up where it was minted.
 */
const READS: Array<[title: string, expected: string]> = [
  // ── The reverse family: five market spellings, ONE card line. ────────────
  ["2004 Pokemon EX FireRed & LeafGreen #77 Reverse Foil", "Reverse Holofoil"],
  ["2015 Pokemon XY Ancient Origins #67 Reverse Holo", "Reverse Holofoil"],
  ["2025 Pokemon Scarlet & Violet Prismatic Evolutions #105 Reverse", "Reverse Holofoil"],
  ["2023 Pokemon Paldea Evolved #199 - Reverse Holofoil", "Reverse Holofoil"],
  ["2016 Pokemon XY Evolutions #11 Rev Holo", "Reverse Holofoil"],
  ["2019 Pokemon Sun & Moon Unified Minds #61 Reverse Holos", "Reverse Holofoil"],
  ["2021 Pokemon SWSH Chilling Reign Blaziken #23 Reverse Foils", "Reverse Holofoil"],
  ["2011 Pokemon Black & White Emerging Powers #98 Reverse Holofoils", "Reverse Holofoil"],
  ["2007 Pokemon Diamond & Pearl Mysterious Treasures #45 Reverse Holo Near Mint", "Reverse Holofoil"],
  ["Pokemon Sword & Shield Brilliant Stars Charizard V #154 Reverse Holo PSA 10", "Reverse Holofoil"],

  // ── The holo family. NEVER answers a reverse. ────────────────────────────
  ["2022 Pokemon Astral Radiance #104 Holofoil", "Holofoil"],
  ["1999 Pokemon Base Set Charizard #4 Holo", "Holofoil"],
  ["2023 Pokemon Obsidian Flames Charizard ex #125 - Holofoil", "Holofoil"],
  ["2020 Pokemon Champion's Path Charizard V #79 Holo Foil", "Holofoil"],
  ["2000 Pokemon Team Rocket Dark Charizard #4 Holo Rare", "Holofoil"],
  ["2017 Pokemon Sun & Moon Burning Shadows #20 Holos", "Holofoil"],
  ["2003 Pokemon EX Ruby & Sapphire Blaziken #11 Foil", "Holofoil"],
  ["2024 Pokemon Surging Sparks Pikachu ex #238 Holofoil PSA 10 Gem Mint", "Holofoil"],

  // ── Era-specific finishes, each its own card line. ───────────────────────
  ["1999 Pokemon Base Set #58 Pikachu Cosmos Holo", "Cosmos Holo"],
  ["1999 Pokemon Jungle Scyther #10 Cosmos", "Cosmos Holo"],
  ["2003 Pokemon EX Dragon #100 Cracked Ice", "Cracked Ice"],
  ["2002 Pokemon Legendary Collection Machamp #12 Cracked Ice Holofoil", "Cracked Ice"],

  // ── The un-foiled line. TCGplayer's own word for it. ─────────────────────
  ["2021 Pokemon Evolving Skies Umbreon VMAX #215 - Normal", "Normal"],
  ["2023 Pokemon 151 Charizard ex #199 - Normal", "Normal"],
  ["2022 Pokemon Lost Origin Giratina V #186 Normal Near Mint", "Normal"],
];

describe("CF-A-FINISH-IS-A-CARD-LINE — the finish reaches parseTitleIdentity", () => {
  it("reads the stated finish on 25 real title shapes across every era", () => {
    expect(READS.length).toBeGreaterThanOrEqual(25);
    for (const [title, expected] of READS) {
      expect(parallelOf(title), title).toBe(expected);
    }
  });

  it("the reverse family NEVER answers a holo — longest phrase wins", () => {
    // The whole reason precedence is longest-first. "Reverse Holo" CONTAINS
    // "Holo", so a shortest-first reader would fold 215,231 reverse sales into
    // a holo pool -- the exact corruption #1937's family separation prevents.
    for (const t of [
      "2015 Pokemon XY Ancient Origins #67 Reverse Holo",
      "2004 Pokemon EX FireRed & LeafGreen #77 Reverse Foil",
      "2016 Pokemon XY Evolutions #11 Rev Holo",
      "2023 Pokemon Paldea Evolved #199 - Reverse Holofoil",
    ]) {
      expect(parallelOf(t), t).toBe("Reverse Holofoil");
      expect(parallelOf(t), t).not.toBe("Holofoil");
    }
  });

  it("a Pokemon title stating NO finish is left alone — blank means the base row", () => {
    // CF-BLANK-MEANS-UNKNOWN, at the slug layer: `normalizeParallel` collapses
    // "", "base", "none" and "no-parallel" to the SAME token `base`, so "Base"
    // here is the parser's own sentinel for "nothing stated" and mints no
    // parallel row of its own -- it IS the checklist card's base row. The
    // reader must not invent a finish where the title states none.
    for (const t of [
      "2024 Pokemon Surging Sparks Pikachu ex #238 PSA 10",
      "2023 Pokemon 151 Charizard ex #199",
      "1999 Pokemon Base Set Machop #52",
    ]) {
      expect(parallelOf(t), t).toBe("Base");
    }
    for (const blank of ["", "Base", "none", "no-parallel"]) {
      expect(normalizeParallel(blank)).toBe("base");
    }
  });

  it("a multi-card LOT states no one card's finish", () => {
    // The same refusal `statedFinishFromChecklist` carries, for the same
    // reason: a lot's title describes several cards and none of them.
    expect(parallelOf("Pokemon Lot of 6 Reverse Holo Cards Vintage WOTC")).toBe("Base");
    expect(parallelOf("40x Pokemon Holofoil Cards Bulk Lot")).toBe("Base");
  });
});

// ---------------------------------------------------------------------------
// 2. THE NEGATIVES. Sports keep every answer they had.
// ---------------------------------------------------------------------------

describe("CF-A-FINISH-IS-A-CARD-LINE — the gate keeps sports out", () => {
  /**
   * "Holo" is Panini Optic's word for a Holo prizm, "Gold Foil" is a real
   * 1990s Topps/Fleer parallel, and "Reverse" is ordinary sports title text.
   * Folding `foil` -> `holofoil` on a baseball card would merge a Gold Foil
   * pool into a holofoil pool that does not exist in that hobby at all.
   *
   * Each expectation below is the answer main ALREADY gave -- this is a
   * no-change assertion, which is what makes it a regression pin.
   */
  const NEGATIVES: Array<[title: string, expected: string]> = [
    // The named sports parallels that contain a finish word. Unchanged.
    ["1992 Topps Gold Foil Baseball #200 Cal Ripken Jr.", "Gold Foil"],
    ["1993 Topps Finest Baseball #100 Refractor", "Refractor"],
    ["2021 Panini Prizm Football #1 Reverse Silver", "Silver Prizm"],
    // The finish words that stay Base in the sports hobby, exactly as before.
    ["1996 Fleer Metal Universe Basketball #100 Holo", "Base"],
    ["1997 Fleer Ultra Basketball #50 Holo", "Base"],
    ["2024 Topps Stadium Club Baseball #1 Black Foil", "Base"],
    ["1995 Upper Deck Hockey #200 Foil", "Base"],
    ["2023 Panini Donruss Optic Basketball #12 Holo", "Base"],
    ["1998 Topps Baseball #30 Reverse Negative", "Base"],
  ];

  it("a sports title's Holo / Foil / Reverse is never a Pokemon finish", () => {
    for (const [title, expected] of NEGATIVES) {
      expect(parallelOf(title), title).toBe(expected);
    }
  });

  it("the reader itself is pure vocabulary — the GATE is what keeps it out", () => {
    // `pokemonFinishFromTitle` answers on the words alone; it is `extractParallel`'s
    // `isPokemon` gate that decides whether it is ever consulted. Pinning both
    // halves separately means a mutation that drops the gate cannot hide behind
    // a reader that happens to answer null.
    expect(pokemonFinishFromTitle("1996 Fleer Metal Universe Basketball #100 Holo")?.token)
      .toBe("holofoil");
    expect(parallelOf("1996 Fleer Metal Universe Basketball #100 Holo")).toBe("Base");
  });
});

// ---------------------------------------------------------------------------
// 3. ONE VOCABULARY. The mirror is pinned equal to the mint lane's.
// ---------------------------------------------------------------------------

describe("CF-A-FINISH-IS-A-CARD-LINE — one vocabulary, pinned equal", () => {
  it("FINISH_TOKENS mirrors scripts/lib/pokemon-finish-vocab.cjs in BOTH directions", () => {
    // A word added to the `.cjs` and not here is a spelling the mint lane
    // writes rows at and the parser cannot read -- silently, which is how the
    // gap this PR fixes was created. Both directions, key for key.
    expect(Object.keys(__FINISH_TOKENS_FOR_TEST).sort())
      .toEqual(Object.keys(VOCAB.FINISH_TOKENS).sort());
    for (const [k, v] of Object.entries(VOCAB.FINISH_TOKENS)) {
      expect(__FINISH_TOKENS_FOR_TEST[k], `token ${k} drifted`).toBe(v);
    }
  });

  it("FINISH_DISPLAY mirrors the mint lane's display names in BOTH directions", () => {
    expect(Object.keys(__FINISH_DISPLAY_FOR_TEST).sort())
      .toEqual(Object.keys(VOCAB.FINISH_DISPLAY).sort());
    for (const [k, v] of Object.entries(VOCAB.FINISH_DISPLAY)) {
      expect(__FINISH_DISPLAY_FOR_TEST[k], `display ${k} drifted`).toBe(v);
    }
  });

  it("every title-spelling alias resolves to a REAL token — no side vocabulary", () => {
    // The alias map exists only for prose forms that have no slug spelling
    // ("Rev Holo", "Holo Foil"). If one resolved to something the token table
    // does not carry, the parser would answer at an address the mint lane never
    // writes -- the multi-home defect, reintroduced at the reader.
    for (const [alias, target] of Object.entries(__TITLE_SPELLING_ALIASES_FOR_TEST)) {
      expect(VOCAB.FINISH_TOKENS, `alias ${alias} -> ${target} is not a real token`)
        .toHaveProperty(target);
    }
  });

  it("every answer is a normalizeParallel FIXED POINT through its own token", () => {
    // The property that makes the parser's answer an ADDRESS. A row minted
    // "Reverse Holofoil" and a sale parsed "Reverse Holofoil" must slug to the
    // same segment, and that segment must be a fixed point of the #1937 fold --
    // otherwise the parser writes one address and the catalog holds another.
    for (const [token, display] of Object.entries(__FINISH_DISPLAY_FOR_TEST)) {
      const slug = normalizeParallel(display);
      expect(slug, `${display} must slug to its own token`).toBe(token);
      expect(foldPokemonFinishToken(slug), `${slug} must be a fold fixed point`).toBe(token);
    }
  });

  it("every READ answer is itself a display name the mint lane writes", () => {
    // Closes the loop: the parser can only ever emit a name that addresses a
    // row `mint-attested-finish-rows` actually mints.
    const displays = new Set(Object.values(VOCAB.FINISH_DISPLAY));
    for (const [, expected] of READS) {
      expect(displays, `${expected} is not a mint-lane display name`).toContain(expected);
    }
  });

  it("the reader answers the SAME token the slug fold would have reached", () => {
    // The two mechanisms must agree. Before this PR the fold was the only
    // reader of these spellings and the parser dropped them; now the parser
    // answers first, and its answer must land exactly where the fold pointed.
    for (const [spelling, token] of Object.entries(VOCAB.FINISH_TOKENS)) {
      expect(foldPokemonFinishToken(spelling), `${spelling} disagrees with the fold`).toBe(token);
    }
  });
});
