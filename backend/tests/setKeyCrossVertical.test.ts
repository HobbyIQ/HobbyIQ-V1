// CF-NO-CROSS-VERTICAL-FALLBACK + CF-OPTIC-WITHOUT-PANINI (Drew, 2026-08-17).
//
// Two findings from CF-COLLAPSED-SETKEY-AUDIT, which measured 1,634,282 sales
// (15.2% of the index) sitting on a setKey their own setName contradicts.

import { describe, it, expect } from "vitest";
import {
  normalizeSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";

describe("CF-NO-CROSS-VERTICAL-FALLBACK — the sports vocabulary has no jurisdiction over Pokemon", () => {
  // A Pokemon alias MISS used to fall through to normalizeSetKey, which matched
  // Pokemon set names against Panini products and produced slugs like
  // `hiq:pokemon:2023:panini-obsidian:106:base:no-auto`. Measured 2026-08-17:
  // 59,748 Pokemon rows carried a sports/Panini setKey.
  const PANINI_KEYS = [
    "panini-obsidian", "panini-zenith", "panini-origins", "panini-prizm",
    "panini-select", "panini-donruss", "panini-optic", "donruss-optic", "leaf", "ultra",
  ];

  it("never returns a Panini/sports key for a Pokemon set name", () => {
    for (const name of [
      "2023 Pokemon Scarlet & Violet Obsidian Flames",
      "Crown Zenith",
      "XY Ancient Origins",
      "EX FireRed & LeafGreen",
      "Sun & Moon Ultra Prism",
      "SWSH Silver Tempest",
      "Some Unaliased Pokemon Set That Does Not Exist",
    ]) {
      const key = resolveSetKeyForSlug("pokemon", name, 2023);
      expect(PANINI_KEYS, `"${name}" leaked to ${key}`).not.toContain(key);
    }
  });

  it("still resolves known Pokemon sets through the alias table", () => {
    expect(resolveSetKeyForSlug("pokemon", "1999 Pokemon Base Set", 1999)).toBe("base1");
    expect(resolveSetKeyForSlug("pokemon", "Crown Zenith", 2023)).toBe("swsh12-5");
    expect(resolveSetKeyForSlug("pokemon", "XY Ancient Origins", 2015)).toBe("xy7");
  });

  it("degrades to the slugified name on a miss, not to a sports product", () => {
    // A year-prefixed result is refused by slugGuard and the row stays honestly
    // unkeyed. That is the intended outcome — an absent slug beats a wrong one.
    const key = resolveSetKeyForSlug("pokemon", "2029 Pokemon Not A Real Set", 2029);
    expect(key).toBe("2029-pokemon-not-a-real-set");
    expect(PANINI_KEYS).not.toContain(key);
  });

  it("leaves the sports vocabulary intact for actual sports cards", () => {
    // The Panini products whose names collide with Pokemon sets must still work.
    expect(resolveSetKeyForSlug("basketball", "2024 Panini Obsidian Basketball", 2024)).toBe("panini-obsidian");
    expect(resolveSetKeyForSlug("basketball", "Panini Zenith", 2024)).toBe("panini-zenith");
    expect(resolveSetKeyForSlug("football", "Panini Origins", 2024)).toBe("panini-origins");
  });
});

describe("CF-OPTIC-WITHOUT-PANINI — Optic is its own product however it is written", () => {
  // The rule required the `panini-` prefix, so bare "Donruss Optic" — how the
  // product is almost always written — fell to the generic donruss rule.
  // Measured 2026-08-17: 196,345 sold_comps rows affected.
  // D31 (Drew, 2026-08-31) renamed the destination: Optic is ONE product
  // and the checklists all spell it donruss-optic. The 2026-08-17 finding
  // this test pins -- that EVERY spelling reaches the one key -- is
  // unchanged; only the key it reaches is. See opticIsOneProduct.test.ts.
  it("routes every spelling of Optic to donruss-optic", () => {
    expect(normalizeSetKey("Donruss Optic")).toBe("donruss-optic");
    expect(normalizeSetKey("Panini Donruss Optic")).toBe("donruss-optic");
    expect(normalizeSetKey("2024 Donruss Optic Basketball")).toBe("donruss-optic");
    expect(normalizeSetKey("Panini Optic")).toBe("donruss-optic");
    expect(normalizeSetKey("Optic")).toBe("donruss-optic");
  });

  it("leaves paper Donruss on its own key", () => {
    // Optic is chrome stock with its own checklist and its own prices. The
    // point of the fix is that these two stay apart.
    expect(normalizeSetKey("Donruss")).toBe("panini-donruss");
    expect(normalizeSetKey("2024 Donruss Baseball")).toBe("panini-donruss");
    expect(normalizeSetKey("Donruss Optic")).not.toBe(normalizeSetKey("Donruss"));
  });

  it("keeps the pre-2009 Donruss gate working through the shared resolver", () => {
    expect(resolveSetKeyForSlug("baseball", "Donruss", 1987)).toBe("donruss");
    expect(resolveSetKeyForSlug("baseball", "Donruss", 2015)).toBe("panini-donruss");
  });
});
