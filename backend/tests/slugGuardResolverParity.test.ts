// CF-ONE-SETKEY-RESOLVER (Drew, 2026-08-17).
//
// The guard that decides whether computeHobbyIqCardId may run must resolve the
// setKey the SAME way computeHobbyIqCardId does. It did not: soldCompsStore fed
// guardSlugInputs `normalizeSetKey(setName)`, skipping the Pokemon alias table
// that the computation applies first. Measured against sold_comps on
// 2026-08-17: of 860,462 null-slug Pokemon comps the guard accepted exactly 1,
// and 615,140 (71.5%) were refused as `setkey-raw-vendor-string` over a leading
// year that the alias table removes.
//
// These tests pin the PARITY, not just the values — a future edit that teaches
// one path a new rule and not the other should fail here.

import { describe, it, expect } from "vitest";
import {
  computeHobbyIqCardId,
  normalizeSetKey,
  resolveSetKeyForSlug,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { guardSlugInputs, isRawVendorSetKey } from "../src/services/portfolioiq/slugGuard.service.js";

/** Real vendor setNames from the null-slug Pokemon population, with the set id
 *  the alias table holds for each. */
const POKEMON_ROWS: ReadonlyArray<{ setName: string; year: number; expected: string }> = [
  { setName: "2024 Pokemon Scarlet & Violet Surging Sparks", year: 2024, expected: "sv08" },
  { setName: "2025 Pokemon Scarlet & Violet Prismatic Evolutions", year: 2025, expected: "sv08-5" },
  { setName: "2023 Pokemon Scarlet & Violet 151", year: 2023, expected: "sv03-5" },
  { setName: "1999 Pokemon Jungle", year: 1999, expected: "base2" },
  { setName: "2016 Pokemon XY Evolutions", year: 2016, expected: "xy12" },
];

describe("CF-ONE-SETKEY-RESOLVER — guard and computation resolve identically", () => {
  it("resolves Pokemon setNames through the alias table, not raw slugify", () => {
    for (const row of POKEMON_ROWS) {
      expect(resolveSetKeyForSlug("pokemon", row.setName, row.year)).toBe(row.expected);
    }
  });

  it("the guard ACCEPTS what it previously refused — the 615,140-row defect", () => {
    for (const row of POKEMON_ROWS) {
      // The old wiring: normalizeSetKey straight into the guard.
      const oldKey = normalizeSetKey(row.setName);
      expect(isRawVendorSetKey(oldKey)).toBe(true); // leading year → refused

      // The new wiring: resolve first, then guard.
      const newKey = resolveSetKeyForSlug("pokemon", row.setName, row.year);
      expect(isRawVendorSetKey(newKey)).toBe(false);
      const guard = guardSlugInputs({
        sport: "pokemon", year: row.year, normalizedSetKey: newKey, cardNumber: "25",
      });
      expect(guard.ok).toBe(true);
      expect(guard.reasons).toEqual([]);
    }
  });

  it("PARITY: the key the guard judges is the key the slug actually carries", () => {
    for (const row of POKEMON_ROWS) {
      const guarded = resolveSetKeyForSlug("pokemon", row.setName, row.year);
      const slug = computeHobbyIqCardId({
        sport: "pokemon", year: row.year, setKey: row.setName,
        cardNumber: "25", parallel: "Base", isAuto: false,
      });
      // Segment 3 of hiq:sport:year:setKey:... is what the guard vetted.
      expect(slug.split(":")[3]).toBe(guarded);
    }
  });

  it("is GATED ON SPORT — the alias table never touches a non-Pokemon set name", () => {
    // "151" is a Scarlet & Violet alias key and would be actively dangerous
    // applied to a baseball product.
    expect(resolveSetKeyForSlug("baseball", "151", 2023))
      .toBe(normalizeSetKey("151"));
    expect(resolveSetKeyForSlug("baseball", "2024 Topps Chrome", 2024))
      .toBe(normalizeSetKey("2024 Topps Chrome"));
  });

  it("still applies the pre-2009 Donruss gate through the shared resolver", () => {
    expect(resolveSetKeyForSlug("baseball", "Donruss", 1987)).toBe("donruss");
    expect(resolveSetKeyForSlug("baseball", "Donruss", 2015)).toBe("panini-donruss");
  });

  it("falls back to normalizeSetKey when Pokemon has no alias (Japanese sets)", () => {
    // The alias table is generated from tcgdex's ENGLISH endpoint and holds
    // zero Japanese keys, so these must degrade, not throw.
    const jp = "2023 Pokemon Japanese Scarlet & Violet 151";
    expect(resolveSetKeyForSlug("pokemon", jp, 2023)).toBe(normalizeSetKey(jp));
  });
});
