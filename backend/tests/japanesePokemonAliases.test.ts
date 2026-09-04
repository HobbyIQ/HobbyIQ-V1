// CF-JAPANESE-POKEMON-ALIASES (Drew, 2026-08-17, supplying pokelenz.com).
//
// Unblocks the population reported as blocked twice: ~202,500 sold_comps rows
// (~49,000/day) naming a Japanese set no source carried in romanized form.
//
// Every JSON source failed — tcgdex /v2/ja/sets is 229 sets of Japanese-script
// names with zero ASCII and ?lang=en ignored; pokemontcg.io lists Japanese as a
// future feature; apitcg.com needs a key. And the two biggest sets by volume
// (Terastal Festival ex, VSTAR Universe) are Japan-exclusive, so no English
// sibling id could be borrowed. pokelenz.com carries romanized name + canonical
// code together.
//
// Measured against live data before building: 89.9% of Japanese sales match.

import { describe, it, expect } from "vitest";
import { resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { guardSlugInputs } from "../src/services/portfolioiq/slugGuard.service.js";

describe("CF-JAPANESE-POKEMON-ALIASES", () => {
  it("resolves Japanese sets to their canonical Japanese code", () => {
    const cases: Array<[string, string]> = [
      ["2023 Pokemon Japanese Scarlet & Violet 151", "sv2a"],
      ["2024 Pokemon Japanese Scarlet & Violet Terastal Festival EX", "sv8a"],
      // CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, R2). Was pinned to
      // "swsh12a", which is not a real set code -- it was our own spelling,
      // scraped wrong, and its swsh- prefix invited collision with the ENGLISH
      // Sword & Shield codes (swsh12 IS Silver Tempest). The JA VSTAR Universe
      // code is s12a.
      ["2022 Pokemon Japanese Sword & Shield VSTAR Universe", "s12a"],
      ["2023 Pokemon Japanese Scarlet & Violet Shiny Treasure EX", "sv4a"],
      // CF-THE-JAPANESE-CODE-IS-THE-KEY, THE SWSH ERA (R4, 2026-09-04). The
      // same amendment as the line above, for the same reason: swsh8b was the
      // EN-era spelling of the JA VMAX Climax code, which is s8b. R2 ruled one
      // of these; R4 ruled the twelve the tcgdex-ja modern lane stages, of
      // which this is the largest by pool volume (14,454 rows). See
      // tests/ruledJapaneseSetKeys.test.ts for the full ruling and for the
      // three swsh keys it deliberately does NOT move.
      ["2021 Pokemon Japanese Sword & Shield VMAX Climax", "s8b"],
    ];
    for (const [name, want] of cases) {
      expect(resolveSetKeyForSlug("pokemon", name, 2023), `"${name}"`).toBe(want);
    }
  });

  /**
   * The load-bearing property. A Japanese set name would otherwise hit the
   * ENGLISH alias table — "Japanese ... 151" contains "151" — and pool Japanese
   * sales into the English card. They are different prints with different
   * markets and must never share an identity.
   */
  it("never collides a Japanese set with its English namesake", () => {
    const jp = resolveSetKeyForSlug("pokemon", "2023 Pokemon Japanese Scarlet & Violet 151", 2023);
    const en = resolveSetKeyForSlug("pokemon", "2023 Pokemon Scarlet & Violet 151", 2023);
    expect(jp).toBe("sv2a");
    expect(en).toBe("sv03-5");
    expect(jp).not.toBe(en);

    // R2's own near-collision: the JA VSTAR Universe code (s12a) and the EN
    // Silver Tempest code (swsh12) are one character apart in the spelling we
    // used to carry ("swsh12a"), which is exactly why the ruled rewrite is
    // exact-token rather than a prefix rule.
    const jpVstar = resolveSetKeyForSlug("pokemon", "2022 Pokemon Japanese Sword & Shield VSTAR Universe", 2022);
    const enTempest = resolveSetKeyForSlug("pokemon", "2022 Pokemon Sword & Shield Silver Tempest", 2022);
    expect(jpVstar).toBe("s12a");
    expect(enTempest).toBe("swsh12");
    expect(jpVstar).not.toBe(enTempest);

    // R1: the JA Rocket Gang set must not answer with the ENGLISH Base Set 2
    // code. One alias line pointing here at `base4` minted 43,724 JA sales onto
    // the English product.
    const jpRocket = resolveSetKeyForSlug("pokemon", "1997 Pokemon Japanese Rocket Gang", 1997);
    const enBase2 = resolveSetKeyForSlug("pokemon", "2000 Pokemon Base Set 2", 2000);
    expect(jpRocket).toBe("japanese-rocket-gang");
    expect(enBase2).toBe("base4");
    expect(jpRocket).not.toBe(enBase2);
  });

  it("leaves the English table completely unaffected", () => {
    expect(resolveSetKeyForSlug("pokemon", "1999 Pokemon Base Set", 1999)).toBe("base1");
    expect(resolveSetKeyForSlug("pokemon", "Crown Zenith", 2023)).toBe("swsh12-5");
    expect(resolveSetKeyForSlug("pokemon", "2024 Pokemon Scarlet & Violet Surging Sparks", 2024)).toBe("sv08");
    expect(resolveSetKeyForSlug("pokemon", "2016 Pokemon XY Evolutions", 2016)).toBe("xy12");
  });

  it("produces a slug end to end, which is the whole point", () => {
    for (const n of [
      "2023 Pokemon Japanese Scarlet & Violet 151",
      "2024 Pokemon Japanese Scarlet & Violet Terastal Festival EX",
      "2022 Pokemon Japanese Sword & Shield VSTAR Universe",
      "1997 Pokemon Japanese Rocket Gang",
    ]) {
      const key = resolveSetKeyForSlug("pokemon", n, 2023);
      const guard = guardSlugInputs({
        sport: "pokemon", year: 2023, normalizedSetKey: key, cardNumber: "1",
      });
      expect(guard.ok, `"${n}" still refused (key=${key})`).toBe(true);
    }
  });

  it("degrades to a clean name on a miss, never to an English id", () => {
    // A Japanese set the source does not carry must NOT fall through to the
    // English table — that is the collision this whole branch exists to prevent.
    const key = resolveSetKeyForSlug("pokemon", "2029 Pokemon Japanese Not A Real Set", 2029);
    expect(key).not.toBe("sv03-5");
    expect(key).not.toMatch(/^sv\d/);
    expect(key.length).toBeGreaterThan(0);
  });
});
