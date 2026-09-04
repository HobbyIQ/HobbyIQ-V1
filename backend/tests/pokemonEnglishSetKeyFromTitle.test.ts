// CF-THE-POKEMON-VOCABULARY-WAS-NEVER-REACHABLE-FROM-THE-TITLE (2026-09-04).
//
// POKEMON_SET_ALIASES has carried the full English vocabulary since 2026-08-16
// — 1,497 aliases over 214 sets, generated from tcgdex, and the spelling
// card_catalog itself is keyed by. But the only caller was
// `resolveSetKeyForSlug`, which is handed a setName the CALLER already holds.
// A re-derivation that has nothing but the TITLE — which is every row the
// Great Rematch walks — could not reach it, so `inferSetKeyFromTitle` hit the
// non-sports guard and returned "Unknown" for every Pokemon sale ever written.
//
// Measured read-only against sold_comps on 2026-09-04, sport=pokemon /
// cardYear=2025: 60,767 of 60,911 rows (99.8%) UNDERIVABLE, all of them on
// `setkey-unknown-unsupported` — NOT the bowman default, which the guard
// intercepts first. The seven largest sets, their keys, and their existing
// tcgdex-scraped catalog rows:
//
//     Prismatic Evolutions  14,631 -> sv08-5   (600)
//     Journey Together       9,162 -> sv09     (484)
//     Destined Rivals        7,751 -> sv10   (1,074)
//     Black Bolt             7,550 -> sv10-5b  (479)
//     White Flare            6,664 -> sv10-5w  (449)
//     Mega Evolution         4,128 -> me01     (505)
//     Phantasmal Flames      2,674 -> me02     (314)
//
// No set name is invented here — CF-NO-SYNTHETIC-PARALLELS is not in play.
// One existing table was made reachable from the one input the caller has.
//
// The mutation pin at the bottom is the load-bearing test: it fails if the
// resolver call is deleted from the guard, which is the exact regression that
// produced the defect.
import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

/** The parser's answer, as the ingest path stores it: normalized. */
const key = (title: string): string => normalizeSetKey(inferSetKeyFromTitle(title));

/** Every set named in the gap, with the key the catalog already uses. */
const SETS: ReadonlyArray<readonly [string, string]> = [
  ["Prismatic Evolutions", "sv08-5"],
  ["Journey Together", "sv09"],
  ["Destined Rivals", "sv10"],
  ["Black Bolt", "sv10-5b"],
  ["White Flare", "sv10-5w"],
  ["Mega Evolution", "me01"],
  ["Phantasmal Flames", "me02"],
  ["Surging Sparks", "sv08"],
  ["Stellar Crown", "sv07"],
  ["Shrouded Fable", "sv06-5"],
  ["Twilight Masquerade", "sv06"],
  ["Temporal Forces", "sv05"],
  ["Paldean Fates", "sv04-5"],
];

describe("CF-THE-POKEMON-VOCABULARY — every listed title mints its key", () => {
  it.each(SETS)("%s -> %s", (name, expected) => {
    expect(key(`2025 Pokemon ${name} Charizard ex #123`)).toBe(expected);
  });

  it("reads the title shapes sellers actually write", () => {
    // With and without the year, with the series spelled out, and with the
    // all-caps slab wording CardHedge derives from the label.
    expect(key("2025 Pokemon Prismatic Evolutions Umbreon ex 161/131 PSA 10")).toBe("sv08-5");
    expect(key("Pokemon Prismatic Evolutions Umbreon ex 161/131")).toBe("sv08-5");
    expect(key("2025 POKEMON SCARLET & VIOLET PRISMATIC EVOLUTIONS #161 UMBREON EX PSA 10")).toBe("sv08-5");
    expect(key("2025 Pokemon SV Destined Rivals Team Rocket's Mewtwo ex #103")).toBe("sv10");
  });

  it("a specialized product is not collapsed into its flagship", () => {
    // `mega-evolution` is a PREFIX of `mega-evolution-phantasmal-flames`.
    // Longest alias wins, or Phantasmal Flames sales pool into me01 — a
    // different card with its own checklist and its own price curve.
    expect(key("2025 Pokemon Mega Evolution Mega Gardevoir ex #85")).toBe("me01");
    expect(key("2025 Pokemon Mega Evolution Phantasmal Flames Gengar ex")).toBe("me02");
    expect(key("2025 Pokemon Mega Evolution Energy #7")).toBe("mee");
  });

  it("EVERY minted key is a normalizeSetKey fixed point", () => {
    // A ruled key MUST survive normalizeSetKey unchanged, or the pool can
    // never name the checklist card_catalog already holds under it.
    for (const [, k] of SETS) expect(normalizeSetKey(k)).toBe(k);
    for (const k of ["me02-5", "mee", "mep"]) expect(normalizeSetKey(k)).toBe(k);
  });

  it("the guard never sees `bowman` or `unknown` for these titles", () => {
    // Both are refusal reasons in rematch-sold-comps.cjs:
    // setkey-bowman-default-unsupported and setkey-unknown-unsupported.
    for (const [name] of SETS) {
      const k = key(`2025 Pokemon ${name} Pikachu ex #100`);
      expect(k.startsWith("bowman")).toBe(false);
      expect(k).not.toBe("unknown");
      expect(k).not.toBe("");
    }
  });
});

describe("CF-THE-POKEMON-VOCABULARY — the boundaries the fix must not cross", () => {
  it("JAPANESE titles are left to the Japanese vocabulary", () => {
    // `151` is a real English set (sv03-5) AND a real Japanese one (sv2a).
    // Claiming a Japanese title here would pool a Japanese print into the
    // English card — a different print with a different market. The English
    // resolver must decline and leave the row to resolveJapanesePokemonSet.
    expect(key("2023 Pokemon Japanese Scarlet & Violet 151 Charizard ex")).toBe("unknown");
    expect(key("2025 Pokemon Japanese Destined Rivals Mewtwo ex")).toBe("unknown");
  });

  it("a non-Pokemon TCG title is untouched", () => {
    // The guard covers Yu-Gi-Oh, MTG, Lorcana and the rest; only the Pokemon
    // branch gained a vocabulary.
    expect(key("2024 Yu-Gi-Oh! Rage of the Abyss Blue-Eyes White Dragon")).toBe("unknown");
    expect(key("2023 Magic The Gathering Lord of the Rings One Ring")).toBe("unknown");
  });

  it("a SPORTS title still reaches its own product rules", () => {
    // The Pokemon branch runs inside the non-sports guard, so nothing above
    // it may change. These are the neighbours most at risk.
    // Verified against unmodified main: this title returns `topps-chrome`
    // there too. The point of the pin is that the Pokemon branch changes
    // NOTHING above it, not that this particular answer is the ideal one.
    expect(key("2024 Topps Chrome Update Paul Skenes #USC1")).toBe("topps-chrome");
    expect(key("2026 Bowman Chrome Prospect Auto CPA-BR")).toBe("bowman-chrome");
  });

  it("a bare Pokemon title with no set name stays Unknown", () => {
    // Absence beats a guess: a title naming no set must NOT acquire one.
    expect(key("Pokemon Charizard PSA 10")).toBe("unknown");
    expect(key("2025 Pokemon Card Lot of 50")).toBe("unknown");
  });

  it("MUTATION PIN — deleting the resolver call re-breaks all 60,767 rows", () => {
    // The defect was not a wrong answer; it was a vocabulary that existed and
    // was never consulted. If `resolveEnglishPokemonSetFromTitle` stops being
    // called from the non-sports guard, every one of these returns to
    // "Unknown" and the Great Rematch refuses the rows again.
    const minted = SETS.map(([name]) => key(`2025 Pokemon ${name} Pikachu ex #100`));
    expect(minted.filter((k) => k === "unknown")).toHaveLength(0);
    expect(new Set(minted).size).toBe(SETS.length);
  });
});
