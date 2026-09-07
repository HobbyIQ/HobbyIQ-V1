// ---------------------------------------------------------------------------
// CF-A-SET-NAME-IS-NEVER-A-PARALLEL (Drew, 2026-09-07, from #1964's I9 audit).
//
// THE FINDING. The title parser turned "SV Twilight Masquerade" into a
// `twilight` PARALLEL minted from half the set's own name. Two independent
// defects produced it, and this file pins both:
//
//   1. THE ALIAS GAP. pokemonSetAliases.ts spelled the set name and the SERIE
//      name ("Scarlet & Violet Twilight Masquerade") but never the era CODE
//      TCGplayer actually writes ("SV Twilight Masquerade", "SV06: Twilight
//      Masquerade"). Measured on main over the 77 English sets in the five
//      numbered eras: 73 of 77 failed to resolve from the `<ERA> <name>` shape.
//
//   2. THE RESIDUE. With no product context, `statedFinishFromChecklist`'s
//      global index is free to answer a word of the set's own NAME, because a
//      Pokemon setKey is an opaque code (`sv06`) that spells nothing.
//      `twilight` is a real parallel name on three SPORTS products, so it
//      cleared both global floors. #1964 measured 2,379 pool rows deriving this
//      way -- an IMPROVE lane on `filled:parallel` would have moved every one of
//      them onto a parallel that does not exist.
//
// THE RULINGS THIS ENFORCES: EN key = tcgdex code; blank means unknown, never a
// guess; a parallel comes only from the finish vocabulary (#1935/#1938) or a
// checklist-attested parallel, NEVER from set-name residue.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { parseListingIdentity, resolveEnglishPokemonSetFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { POKEMON_SET_ALIASES } from "../src/services/catalog/pokemonSetAliases.js";
import { POKEMON_EN_SET_CODES } from "../src/services/catalog/pokemonSetCodes.js";

const pokemon = (title: string) =>
  parseListingIdentity(title, undefined, { vertical: "pokemon" } as never);

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

describe("CF-AN-ERA-CODE-IS-A-SPELLING-OF-THE-SET", () => {
  it("the reported title resolves sv06 with a BLANK parallel", () => {
    // THE PIN #1964 ASKED FOR. The set is right, and the parallel is absent --
    // not "Twilight", which is half the set's own name.
    const t = "Pokemon SV Twilight Masquerade Iron Leaves ex 025/167";
    expect(resolveEnglishPokemonSetFromTitle(t)).toBe("sv06");
    expect(pokemon(t).parallel).toBe("Base");
  });

  it("spells the era code for every numbered era, in every punctuation sellers use", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Pokemon SV Twilight Masquerade Iron Leaves ex", "sv06"],
      ["2024 Pokemon SV Twilight Masquerade Pikachu", "sv06"],
      ["Iron Leaves ex - SV: Twilight Masquerade - Holofoil", "sv06"],
      ["Bloodmoon Ursaluna ex - SV06: Twilight Masquerade", "sv06"],
      ["Charizard ex - SV: Obsidian Flames - Holofoil", "sv03"],
      ["Eevee V - SWSH: Crown Zenith - Holofoil", "swsh12-5"],
      ["Pokemon SWSH Brilliant Stars Charizard", "swsh9"],
      ["Pokemon SM Guardians Rising Pikachu", "sm2"],
      ["Pokemon XY Roaring Skies Rayquaza", "xy6"],
      ["Pokemon BW Plasma Storm Pikachu", "bw8"],
    ];
    for (const [title, want] of cases) {
      expect(resolveEnglishPokemonSetFromTitle(title), title).toBe(want);
    }
  });

  it("the era-prefixed alias exists for every set in a numbered era", () => {
    // GENERATED FROM THE CODE TABLE, NOT LISTED BY HAND -- the same source the
    // generator reads, so a new tcgdex set cannot silently skip its era alias.
    const missing: string[] = [];
    for (const [code, name] of Object.entries(POKEMON_EN_SET_CODES)) {
      const m = code.match(/^(sv|swsh|sm|xy|bw)\d/);
      if (!m) continue;
      const alias = slugify(`${m[1]} ${name}`);
      if (POKEMON_SET_ALIASES[alias] !== code) {
        missing.push(`${alias} -> ${POKEMON_SET_ALIASES[alias] ?? "ABSENT"} (want ${code})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("a bare era is never an alias on its own -- CF-AN-ERA-IS-NOT-A-SET", () => {
    // The era must only ever appear JOINED to a set name. A title saying nothing
    // but "SV" cannot claim a set.
    for (const era of ["sv", "swsh", "sm", "xy", "bw"]) {
      expect(POKEMON_SET_ALIASES[era], era).toBeUndefined();
    }
  });

  it("a numbered era code is NOT admitted bare -- the Sapphire card number stays sports", () => {
    // `SV03` with no colon is a Topps Chrome Sapphire card number, which is why
    // the era gate demands the colon on the numbered form. Widening that is a
    // separate vocabulary decision; this pins that we did not widen it here.
    expect(resolveEnglishPokemonSetFromTitle("2023 Topps Chrome Sapphire #SV03 Player")).toBeNull();
  });
});

describe("CF-A-SET-NAME-IS-NEVER-A-PARALLEL", () => {
  // TEN POKEMON SET NAMES WHOSE WORDS LOOK LIKE PARALLELS. Every one of these
  // words is a real parallel name somewhere in the sports checklist corpus --
  // which is exactly why the residue was minted -- so each is a live trap.
  const RESIDUE_TRAPS: ReadonlyArray<readonly [string, string]> = [
    ["Pokemon Twilight Masquerade Iron Leaves ex 025/167", "sv06"],
    ["Pokemon Shrouded Fable Pecharunt ex 038/064", "sv06-5"],
    ["Pokemon Obsidian Flames Charizard ex 125/197", "sv03"],
    ["Pokemon Paradox Rift Roaring Moon 124/182", "sv04"],
    ["Pokemon Stellar Crown Terapagos ex 128/142", "sv07"],
    ["Pokemon Crown Zenith Lugia VSTAR 139/159", "swsh12-5"],
    ["Pokemon Silver Tempest Lugia V 186/195", "swsh12"],
    ["Pokemon Brilliant Stars Charizard V 154/172", "swsh9"],
    ["Pokemon Fusion Strike Mew VMAX 114/264", "swsh8"],
    ["Pokemon Sword & Shield Zacian V 195/202", "swsh1"],
  ];

  it("never mints a parallel from a word of the matched set's own name", () => {
    for (const [title, setKey] of RESIDUE_TRAPS) {
      expect(resolveEnglishPokemonSetFromTitle(title), title).toBe(setKey);
      expect(pokemon(title).parallel, title).toBe("Base");
    }
  });

  it("no derived parallel is a subset of its own set name, across ALL English sets", () => {
    // THE WHOLE CLASS, not a sample. A derived parallel built entirely from the
    // set's own name words is residue by definition.
    const offenders: string[] = [];
    for (const [code, name] of Object.entries(POKEMON_EN_SET_CODES)) {
      const title = `Pokemon ${name} Pikachu 025/167`;
      const parallel = pokemon(title).parallel;
      if (parallel === "Base") continue;
      const nameWords = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      const words = parallel.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.every((w) => nameWords.has(w))) offenders.push(`${code} "${name}" -> ${parallel}`);
    }
    expect(offenders).toEqual([]);
    // 205 full parses, each loading the checklist corpus index; the default 30s
    // is not enough on a cold cache and a timeout here is not a defect.
  }, 120_000);

  it("suppresses a set name the title states that is NOT the matched set's own", () => {
    // "2025 Pokemon Destined Rivals Team Rocket Mewtwo ex 231/182" is an sv10
    // card whose title also spells `Team Rocket` -- a SUBSET here, and the name
    // of a 2000 set (base5) elsewhere. Reading only the matched product's name
    // would leave `rocket` free to answer, which is the same residue by another
    // route. Pinned because it regressed once: supplying the resolved setKey
    // bypassed the no-context suppression that had been catching it.
    const t = "2025 Pokemon Destined Rivals Team Rocket Mewtwo ex 231/182 SIR";
    expect(resolveEnglishPokemonSetFromTitle(t)).toBe("sv10");
    expect(pokemon(t).parallel).toBe("Base");
  });

  it("STILL READS A REAL FINISH on a set whose name is a residue trap", () => {
    // THE MUTATION GUARD. A guard that suppressed everything would pass every
    // test above and destroy #1938's whole point. A finish stated in words is
    // NOT set-name residue and must survive.
    expect(pokemon("Iron Leaves ex - SV: Twilight Masquerade - Holofoil").parallel).toBe("Holofoil");
    expect(pokemon("Pokemon Twilight Masquerade Pikachu 025/167 Reverse Holofoil").parallel).toBe("Reverse Holofoil");
    expect(pokemon("Pokemon Obsidian Flames Charizard ex 125/197 Reverse Holo").parallel).toBe("Reverse Holofoil");
  });
});
