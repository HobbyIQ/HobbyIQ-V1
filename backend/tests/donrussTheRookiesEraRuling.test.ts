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
 * for the modern Panini-era insert-set siblings.
 *
 * NO ERA BRIDGE (AMENDED after independent review of the first version of
 * this change). `donruss-the-rookies` (the 1987 baseball boxed factory set)
 * and `panini-donruss-the-rookies` (a 2023+ Panini Donruss FOOTBALL/
 * BASKETBALL pack insert, R38) are NOT two eras' spellings of one product --
 * they are TWO UNRELATED products that happen to share a display-name
 * substring. The first version of this change had `spellForEra` bridge them
 * by year at the `PANINI_DONRUSS_FROM_YEAR` boundary, the same shape as the
 * real `donruss`/`panini-donruss` era pair; that was wrong, because it had
 * no sport guard and would fold a 2009+ "Donruss The Rookies" BASEBALL row
 * onto the football/basketball insert's address -- exactly the
 * product-family collapse Drew's 2026-09-03 ruling forbids elsewhere in this
 * table. There is no known 2009+ "Donruss The Rookies" baseball boxed set
 * (every staged `panini-donruss-the-rookies` checklist is football/
 * basketball); that shape is OUT OF SCOPE for this ruling and must not be
 * invented here if it ever appears -- it would need its own ruling, not a
 * silent fold. `donruss-the-rookies` therefore passes through `spellForEra`
 * untouched in EVERY year, and a modern "Panini Donruss The Rookies" title
 * keeps resolving to `panini-donruss-the-rookies` through its own,
 * unrelated R38 insert-set registration -- never through this function.
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

describe("spellForEra does NOT bridge donruss-the-rookies <-> panini-donruss-the-rookies -- they are unrelated products", () => {
  it("donruss-the-rookies passes through untouched in EVERY year, including 2009+", () => {
    // No fold in EITHER direction, at or past the boundary that DOES apply
    // to the real donruss/panini-donruss pair. A 2009+ "Donruss The
    // Rookies" baseball boxed set is not a known product; if one is ever
    // found it needs its own ruling, not a silent fold onto the unrelated
    // football/basketball insert below.
    expect(spellForEra("donruss-the-rookies", 1987)).toBe("donruss-the-rookies");
    expect(spellForEra("donruss-the-rookies", 2008)).toBe("donruss-the-rookies");
    expect(spellForEra("donruss-the-rookies", PANINI_DONRUSS_FROM_YEAR)).toBe("donruss-the-rookies");
    expect(spellForEra("donruss-the-rookies", 2024)).toBe("donruss-the-rookies");
  });

  it("panini-donruss-the-rookies passes through untouched in every year too -- no reverse fold", () => {
    expect(spellForEra("panini-donruss-the-rookies", 1987)).toBe("panini-donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", 2008)).toBe("panini-donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", PANINI_DONRUSS_FROM_YEAR)).toBe("panini-donruss-the-rookies");
    expect(spellForEra("panini-donruss-the-rookies", 2024)).toBe("panini-donruss-the-rookies");
  });

  it("an absent/invalid year still leaves both keys alone", () => {
    for (const y of [null, undefined, 0, NaN]) {
      expect(spellForEra("donruss-the-rookies", y as number | null | undefined)).toBe("donruss-the-rookies");
      expect(spellForEra("panini-donruss-the-rookies", y as number | null | undefined)).toBe("panini-donruss-the-rookies");
    }
  });

  it("the real flagship pair (donruss / panini-donruss) still has its own era rule, unaffected", () => {
    expect(spellForEra("donruss", 1987)).toBe("donruss");
    expect(spellForEra("donruss", PANINI_DONRUSS_FROM_YEAR)).toBe("panini-donruss");
    expect(spellForEra("panini-donruss", 1987)).toBe("donruss");
    expect(spellForEra("panini-donruss", 2024)).toBe("panini-donruss");
  });

  it("no OTHER panini-donruss insert gained a fold either", () => {
    expect(spellForEra("panini-donruss-rated-rookies", 1987)).toBe("panini-donruss-rated-rookies");
    expect(spellForEra("panini-donruss-threads", 1987)).toBe("panini-donruss-threads");
  });

  it("policy 'as-named' is irrelevant here since there is no bridge to disable", () => {
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

  it("every vintage-era 'Donruss The Rookies' title resolves to the same registered key (1988, 1990, 1992, 2002)", () => {
    // normalizeSetKey has no year in hand at all -- productSetKeyForName
    // answers by NAME, not by era -- so every one of these resolves to the
    // one registered `donruss-the-rookies` product regardless of year. This
    // is intentionally NOT an era rule: the key is scoped to its one real
    // product by the staged checklist data, not by a year boundary in code.
    expect(normalizeSetKey("1988 Donruss The Rookies")).toBe("donruss-the-rookies");
    expect(normalizeSetKey("1990 Donruss The Rookies")).toBe("donruss-the-rookies");
    expect(normalizeSetKey("1992 Donruss The Rookies")).toBe("donruss-the-rookies");
    expect(normalizeSetKey("2002 Donruss The Rookies")).toBe("donruss-the-rookies");
  });

  it("a modern football/basketball 'Panini Donruss The Rookies' title is UNCHANGED -- still its own insert, never folded", () => {
    expect(normalizeSetKey("2023 Panini Donruss The Rookies")).toBe("panini-donruss-the-rookies");
    const id = computeHobbyIqCardId({
      sport: "football", year: 2023, setKey: "2023 Panini Donruss The Rookies", cardNumber: "5",
    });
    expect(id).toBe("hiq:football:2023:panini-donruss-the-rookies:5:base:no-auto");
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
