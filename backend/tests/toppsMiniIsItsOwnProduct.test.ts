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

  it("the title parser reads a real sale title through to topps-mini", () => {
    const family = inferSetKeyFromTitle("1975 Topps Mini Robin Yount #223 PSA 8", "223");
    expect(normalizeSetKey(family, "baseball")).toBe("topps-mini");
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
