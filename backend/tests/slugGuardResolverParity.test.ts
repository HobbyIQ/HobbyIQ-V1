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
      // CF-CHRONIC-REDS-DRIFT (2026-09-03). This block used to re-enact the
      // ORIGINAL defect: `normalizeSetKey(setName)` kept the leading year, the
      // guard saw `2024-pokemon-...`, and refused it as a raw vendor string.
      //
      // normalizeSetKey has since been taught to strip the leading year at the
      // source (CF-YEAR-IS-NOT-A-SEGMENT, hobbyIqCardId.service.ts: "the year
      // is duplicated into a segment the slug already carries"). So the old
      // wiring can no longer PRODUCE a year-prefixed key, and asserting that
      // it still does pinned a bug the codebase has legitimately outgrown --
      // it was failing on all five rows.
      //
      // What this test is FOR is the parity of guard and computation, and that
      // is unchanged and still asserted below. What is pinned here now is the
      // invariant the old line MEANT: a year-prefixed key is what the guard
      // refuses. Assert that against the guard directly, on a synthetic key,
      // so it holds whichever upstream path stops producing one.
      expect(isRawVendorSetKey(`${row.year}-${normalizeSetKey(row.setName)}`)).toBe(true);
      // ...and the real normalizer no longer hands the guard such a key at all.
      expect(normalizeSetKey(row.setName)).not.toMatch(/^\d{4}-/);

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

  it("resolves Japanese sets to their own code, not the English one", () => {
    // SUPERSEDED 2026-08-17. This case used to assert that Japanese sets
    // DEGRADED to normalizeSetKey, because the alias table was generated from
    // tcgdex's English endpoint and held zero Japanese keys. That was a
    // limitation being documented, not a guarantee worth keeping.
    //
    // CF-JAPANESE-POKEMON-ALIASES now resolves them from a romanized source, so
    // the assertion flips: the Japanese print gets its own identity and must
    // never share one with the English card of the same name. Kept here — where
    // the old expectation lived — so the change of contract is visible.
    const jp = "2023 Pokemon Japanese Scarlet & Violet 151";
    const en = "2023 Pokemon Scarlet & Violet 151";
    expect(resolveSetKeyForSlug("pokemon", jp, 2023)).toBe("sv2a");
    expect(resolveSetKeyForSlug("pokemon", en, 2023)).toBe("sv03-5");
    expect(resolveSetKeyForSlug("pokemon", jp, 2023))
      .not.toBe(resolveSetKeyForSlug("pokemon", en, 2023));
  });
});
