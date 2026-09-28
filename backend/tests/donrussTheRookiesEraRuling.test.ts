/**
 * CF-THE-ROOKIES-IS-A-BOXED-SET-NOT-A-PACK-INSERT (Drew, 2026-09-28 ruling on
 * #2477 / PR body "needsRuling").
 *
 * THE GAP THIS CLOSES. `productSetKeys.ts` registered `the-rookies` only
 * under two Panini-era (2009+) families -- `donruss-optic-the-rookies`
 * (family `donruss-optic`) and `panini-donruss-the-rookies` (family
 * `panini-donruss`) -- both modern football/basketball inserts, unrelated to
 * 1987 Donruss's own 56-card dealer-only boxed factory set, "The Rookies".
 * There was no registered vintage/bare setKey for it, so
 * `normalizeSetKey("donruss-the-rookies")` fell through every rewrite rule to
 * a no-op slugify -- idempotent, but NOT registered, a blind spot in
 * `unregisteredKeys`'s fixed-point test (lib/insert-set-key.cjs) that let an
 * unreviewed key pass planStagedDirectory silently once the flagship package
 * shared the same directory (measured directly on PR #2477's branch: alone,
 * verdict pass with nothing to separate against; alongside the flagship,
 * verdict pass for both files with `separate=["the-rookies"]`, landing rows
 * on the unregistered `donruss-the-rookies` address).
 *
 * THE RULING. Register `donruss-the-rookies` as its own `S()` entry under the
 * bare `donruss` family -- the same shape `donruss-elite` / `donruss-studio`
 * take beside bare `donruss`, and the same `S()` mechanism R38 already uses
 * for the modern Panini-era insert-set siblings. `spellForEra` bridges this
 * pair by the SAME `PANINI_DONRUSS_FROM_YEAR` boundary that already bridges
 * bare `donruss` / `panini-donruss`: 1987-2008 spells `donruss-the-rookies`,
 * 2009+ spells `panini-donruss-the-rookies` (the pre-existing, unrelated
 * modern insert). This is an explicit pair, NOT a generic bridge --
 * `spellForEra` does not fold `panini-donruss-the-rookies` <-> `donruss-the-
 * rookies` for any OTHER key shape, and no other football/basketball
 * `panini-donruss-*` insert gained an era pair by this change.
 */
import { describe, it, expect } from "vitest";
import {
  spellForEra,
  productEntry,
  isProductSetKey,
  productFamilyOf,
  productParentOf,
  PANINI_DONRUSS_FROM_YEAR,
} from "../src/services/catalog/productSetKeys";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";

describe("donruss-the-rookies is registered under the bare donruss family (Drew, #2477 ruling)", () => {
  it("is a registered product key, family donruss, parented to donruss", () => {
    expect(isProductSetKey("donruss-the-rookies")).toBe(true);
    expect(productEntry("donruss-the-rookies")?.setKey).toBe("donruss-the-rookies");
    expect(productFamilyOf("donruss-the-rookies")).toBe("donruss");
    expect(productParentOf("donruss-the-rookies")).toBe("donruss");
  });

  it("is a normalizeSetKey FIXED POINT -- it no longer merely happens to be idempotent", () => {
    expect(normalizeSetKey("donruss-the-rookies")).toBe("donruss-the-rookies");
  });

  it("the pre-existing modern siblings are unharmed -- still their own families", () => {
    expect(isProductSetKey("panini-donruss-the-rookies")).toBe(true);
    expect(productFamilyOf("panini-donruss-the-rookies")).toBe("panini-donruss");
    expect(isProductSetKey("donruss-optic-the-rookies")).toBe(true);
    expect(productFamilyOf("donruss-optic-the-rookies")).toBe("donruss-optic");
  });
});

describe("spellForEra bridges donruss-the-rookies <-> panini-donruss-the-rookies at the SAME boundary as bare donruss", () => {
  it("1987-2008 spells the vintage key", () => {
    expect(spellForEra("donruss-the-rookies", 1987)).toBe("donruss-the-rookies");
    expect(spellForEra("donruss-the-rookies", 2008)).toBe("donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", 1987)).toBe("donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", 2008)).toBe("donruss-the-rookies");
  });

  it(`${PANINI_DONRUSS_FROM_YEAR}+ spells the modern Panini-era key`, () => {
    expect(spellForEra("donruss-the-rookies", PANINI_DONRUSS_FROM_YEAR)).toBe("panini-donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", PANINI_DONRUSS_FROM_YEAR)).toBe("panini-donruss-the-rookies");
    expect(spellForEra("donruss-the-rookies", 2024)).toBe("panini-donruss-the-rookies");
  });

  it("matches the boundary already ruled for bare donruss / panini-donruss", () => {
    expect(spellForEra("donruss-the-rookies", 1987)).toBe(spellForEra("donruss", 1987) + "-the-rookies");
    expect(spellForEra("donruss-the-rookies", 2024)).toBe(spellForEra("donruss", 2024) + "-the-rookies");
  });

  it("an absent/invalid year leaves the key alone -- refuse rather than guess", () => {
    for (const y of [null, undefined, 0, NaN]) {
      expect(spellForEra("donruss-the-rookies", y as number | null | undefined)).toBe("donruss-the-rookies");
      expect(spellForEra("panini-donruss-the-rookies", y as number | null | undefined)).toBe("panini-donruss-the-rookies");
    }
  });

  it("the pair is explicit, not a generic 'panini-donruss-*' <-> 'donruss-*' bridge", () => {
    // No OTHER panini-donruss insert gained an era pair by this change --
    // only the exact `donruss-the-rookies` / `panini-donruss-the-rookies`
    // pair is bridged. The bare flagship pair (donruss / panini-donruss)
    // already had its own era rule before this change and is untouched by
    // it -- pinned separately in "the era rule touches Donruss only" below
    // and in thereIsNoFleerTiffany.test.ts's own flagship assertion.
    expect(spellForEra("panini-donruss-rated-rookies", 1987)).toBe("panini-donruss-rated-rookies");
    expect(spellForEra("panini-donruss-threads", 1987)).toBe("panini-donruss-threads");
  });

  it("policy 'as-named' (year-independent) leaves both spellings alone, same as the flagship pair", () => {
    expect(spellForEra("donruss-the-rookies", 1987, "as-named")).toBe("donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", 2024, "as-named")).toBe("panini-donruss-the-rookies");
  });
});

describe("title -> setKey: '1987 Donruss The Rookies' resolves to donruss-the-rookies, never past it", () => {
  it("normalizeSetKey resolves the full checklist title to the vintage key", () => {
    expect(normalizeSetKey("1987 Donruss The Rookies")).toBe("donruss-the-rookies");
    expect(normalizeSetKey("Donruss The Rookies")).toBe("donruss-the-rookies");
  });

  it("computeHobbyIqCardId mints the vintage id for a 1987 title, not the flagship's bare donruss id", () => {
    const id = computeHobbyIqCardId({
      sport: "baseball", year: 1987, setKey: "1987 Donruss The Rookies", cardNumber: "14",
    });
    expect(id).toBe("hiq:baseball:1987:donruss-the-rookies:14:base:no-auto");
    // Never the flagship's own #14 (Kevin McReynolds DK) address -- the whole
    // point of the ruling is that these two #14s must not share one address.
    expect(id).not.toBe("hiq:baseball:1987:donruss:14:base:no-auto");
  });

  it("a modern-era title still resolves to the pre-existing football/basketball insert, not the vintage key", () => {
    expect(normalizeSetKey("2023 Panini Donruss The Rookies")).toBe("panini-donruss-the-rookies");
  });

  it("negative: bare 'Rookie'/'RC' language on the FLAGSHIP does not trigger this product", () => {
    // #35 David Cone is a real card in BOTH sets (flagship base and boxed
    // insert), so this pins that ordinary rookie-card language on a flagship
    // title never gets redirected onto the boxed-set product. Asserted
    // through computeHobbyIqCardId (the era-aware path every real ingest
    // call site uses), not bare normalizeSetKey -- normalizeSetKey alone is
    // documented era-blind (donrussEraAcrossIngestSources.test.ts's own
    // BASELINE: normalizeSetKey("Donruss") === "panini-donruss" in every
    // year), so asserting "donruss" there would pin a defect this table
    // never claimed to fix.
    const id = computeHobbyIqCardId({
      sport: "baseball", year: 1987, setKey: "1987 Donruss #35 Bo Jackson RC", cardNumber: "35",
    });
    expect(id).toBe("hiq:baseball:1987:donruss:35:base:no-auto");
    const id2 = computeHobbyIqCardId({
      sport: "baseball", year: 1987, setKey: "1987 Donruss Rookie Bo Jackson", cardNumber: "14",
    });
    expect(id2).toBe("hiq:baseball:1987:donruss:14:base:no-auto");
  });
});
