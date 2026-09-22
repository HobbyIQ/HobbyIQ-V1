// Acquisition builder, 2026-09-22 (owner ruling: "topps-mini IS its own
// product key"). 1975 Topps Mini is a smaller-format parallel print run of
// the flagship 660-card checklist, card for card, on the SAME numbers as
// 1975 Topps base -- the Tiffany/Glossy shape, not a distinct roster. Without
// this registration "1975 Topps Mini #660 ..." fell through to the bare
// /topps/ catch-all (productSetKeys.ts:746) and pooled a different-market
// card onto the same address as its flagship base sibling.
//
// Registered with P(), not S(): "topps-mini" is a two-segment name and the
// bare-alias / family regex vocabulary already carries an anchored
// `[/topps-mini/, "topps-mini"]` rule ABOVE the bare `/topps/` catch-all
// (hobbyIqCardId.service.ts), mirroring how topps-tiffany / topps-traded
// are registered and routed. See SAME_NUMBER_PARALLEL_SETS in
// productSetKeys.ts for the same-numbers declaration this product needs so
// the rematch's L5 leg does not require a distinguishing number.
import { describe, it, expect } from "vitest";
import {
  isProductSetKey,
  productParentOf,
  productFamilyOf,
  isSameNumberParallelSet,
} from "../src/services/catalog/productSetKeys";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service";

describe("topps-mini (1975 Topps Mini) is registered", () => {
  it("is a known product set key", () => {
    expect(isProductSetKey("topps-mini")).toBe(true);
  });

  it("nests under topps, same shape as topps-tiffany", () => {
    expect(productParentOf("topps-mini")).toBe("topps");
    expect(productParentOf("topps-tiffany")).toBe("topps");
  });

  it("is its own pricing family (no family override, same as topps-tiffany -- a distinct market, not flagship's)", () => {
    expect(productFamilyOf("topps-mini")).toBe("topps-mini");
    expect(productFamilyOf("topps-tiffany")).toBe("topps-tiffany");
  });

  it("is declared a same-number parallel set of topps (title is the evidence, not the number)", () => {
    expect(isSameNumberParallelSet("topps-mini", "topps")).toBe(true);
  });

  it("is a normalizeSetKey fixed point", () => {
    expect(normalizeSetKey("topps-mini", "baseball")).toBe("topps-mini");
  });

  it('normalizeSetKey resolves "1975 Topps Mini" title text to topps-mini, anchored above bare /topps/', () => {
    expect(normalizeSetKey("1975 Topps Mini", "baseball")).toBe("topps-mini");
    expect(normalizeSetKey("Topps Mini", "baseball")).toBe("topps-mini");
  });

  it("computeHobbyIqCardId mints hiq:baseball:1975:topps-mini:660:... for a Topps Mini title", () => {
    const id = computeHobbyIqCardId({
      sport: "baseball",
      year: 1975,
      setKey: "1975 Topps Mini",
      cardNumber: "660",
      parallel: "Base",
      isAuto: false,
    });
    expect(id).toBe("hiq:baseball:1975:topps-mini:660:base:no-auto");
  });

  it("the title parser reads a real 1975 sale title through to topps-mini", () => {
    const family = inferSetKeyFromTitle("1975 Topps Mini Robin Yount #223 PSA 8", "223");
    expect(normalizeSetKey(family, "baseball")).toBe("topps-mini");
  });

  // CF-TOPPS-MINI-IS-THREE-PRODUCTS (fix, 2026-09-22): Topps sold a
  // DIFFERENT "Topps Mini" in 1987 and 2013-2023 (online-exclusive) with no
  // checklist behind either. A non-1975 "Topps Mini" title must fall
  // through to whatever it resolved to BEFORE this PR -- bare flagship
  // `topps` -- never the 1975 checklist's numbers.
  it.each([1987, 2013, 2019, 2023])(
    "a %d Topps Mini title stays on flagship topps, not the 1975 checklist",
    (year) => {
      const family = inferSetKeyFromTitle(`${year} Topps Mini Mike Trout #100`, "100");
      expect(normalizeSetKey(family, "baseball")).toBe("topps");
      const id = computeHobbyIqCardId({
        sport: "baseball",
        year,
        setKey: `${year} Topps Mini`,
        cardNumber: "100",
        parallel: "Base",
        isAuto: false,
      });
      expect(id).toBe(`hiq:baseball:${year}:topps:100:base:no-auto`);
    },
  );

  it(
    "KNOWN MISS, left open 2026-09-22: 'Topps ... Mini' word order (brand and " +
      "product word separated) is NOT recognised and falls to flagship topps " +
      "-- not widened for lack of a measured word-order population and the " +
      "risk of 'Mini' false positives (Mini Helmet, Mini Bobblehead, etc.)",
    () => {
      const family = inferSetKeyFromTitle("1975 Topps #660 Mini condition Hank Aaron", "660");
      expect(normalizeSetKey(family, "baseball")).toBe("topps");
    },
  );

  it("an absent/unparseable year for a Topps Mini setKey also falls back to topps, never guesses 1975", () => {
    // spellForEra cannot decide without a year, and the pre-registration
    // behaviour for a yearless call was already the bare family -- this
    // preserves that rather than defaulting to the one registered era.
    const id = computeHobbyIqCardId({
      sport: "baseball",
      year: NaN as unknown as number,
      setKey: "Topps Mini",
      cardNumber: "100",
      parallel: "Base",
      isAuto: false,
    });
    expect(id).toBe("hiq:baseball:0:topps:100:base:no-auto");
  });

  it("does not disturb flagship: computeHobbyIqCardId still mints hiq:baseball:1975:topps:660:... for plain 1975 Topps", () => {
    const id = computeHobbyIqCardId({
      sport: "baseball",
      year: 1975,
      setKey: "1975 Topps",
      cardNumber: "660",
      parallel: "Base",
      isAuto: false,
    });
    expect(id).toBe("hiq:baseball:1975:topps:660:base:no-auto");
  });
});
