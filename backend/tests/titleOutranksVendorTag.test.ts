import { describe, it, expect } from "vitest";
import { parallelTheTitleAllows } from "../src/services/portfolioiq/titleOutranksVendorTag.js";
import { parseListingTitle } from "../src/services/portfolioiq/ebayTitleParser.service.js";

// CF-THE-TITLE-OUTRANKS-THE-VENDOR-TAG (Drew, 2026-08-29). The Marconi German
// case: a CardHedge base auto ("2026 Bowman Marconi German Chrome Auto 1st
// Prospect #CPA-MG - Raw") carried the vendor tag "Gold" and landed under the
// Gold Refractor /50 slug.
describe("the title outranks the vendor tag", () => {
  it("a silent title stays Base even when the vendor says Gold", () => {
    expect(parallelTheTitleAllows(null, "Gold")).toEqual({ parallel: null, vendorTagOverruled: "Gold" });
    expect(parallelTheTitleAllows("Base", "Gold")).toEqual({ parallel: null, vendorTagOverruled: "Gold" });
  });
  it("a title that names a finish keeps it over a different vendor tag", () => {
    expect(parallelTheTitleAllows("Gold Refractor", "Gold")).toEqual({ parallel: "Gold Refractor", vendorTagOverruled: "Gold" });
    expect(parallelTheTitleAllows("Blue", "Gold")).toEqual({ parallel: "Blue", vendorTagOverruled: "Gold" });
  });
  it("agreement is not an overrule", () => {
    expect(parallelTheTitleAllows("Gold", "gold")).toEqual({ parallel: "Gold", vendorTagOverruled: null });
    expect(parallelTheTitleAllows(null, null)).toEqual({ parallel: null, vendorTagOverruled: null });
    expect(parallelTheTitleAllows(null, "Base")).toEqual({ parallel: null, vendorTagOverruled: null });
  });
  it("a vendor tag that REFINES the title's finish is adopted (the parser drops the colour from 'Gold Refractor')", () => {
    expect(parallelTheTitleAllows("Refractor", "Gold Refractor")).toEqual({ parallel: "Gold Refractor", vendorTagOverruled: null });
    expect(parallelTheTitleAllows("Refractor", "Blue")).toEqual({ parallel: "Blue", vendorTagOverruled: null });
    expect(parallelTheTitleAllows("Refractor", "Gold")).toEqual({ parallel: "Gold", vendorTagOverruled: null });
  });
  it("a refinement needs a finish to refine: a silent title is still Base", () => {
    expect(parallelTheTitleAllows(null, "Gold Refractor")).toEqual({ parallel: null, vendorTagOverruled: "Gold Refractor" });
  });
  it("the vendor can never add a finish the title lacks", () => {
    expect(parallelTheTitleAllows(null, "Refractor").parallel).toBeNull();
  });
});

// CF-THE-FULLER-SPELLING-IS-THE-SAME-FINISH (Drew, 2026-08-31). The CPA-VF
// case: the parser reads "…Black & White Red Ink #CPA-VF" as "Black White Red"
// (it drops "&" and the trailing "Ink"). Without this, a genuine Red Ink sale
// is filed under a "Black White Red" row of its own — a split pool.
describe("a fuller vendor spelling of the SAME finish is adopted", () => {
  it("the title's words being a subset of the tag's is one finish, not two", () => {
    expect(parallelTheTitleAllows("Black White Red", "Black & White Red Ink"))
      .toEqual({ parallel: "Black & White Red Ink", vendorTagOverruled: null });
  });
  it("a silent title can NEVER subset its way into a finish (the poisoning case)", () => {
    expect(parallelTheTitleAllows(null, "Black & White Red Ink"))
      .toEqual({ parallel: null, vendorTagOverruled: "Black & White Red Ink" });
    expect(parallelTheTitleAllows("Base", "Black & White Red Ink").parallel).toBeNull();
  });
  it("a title word the tag lacks is still a real disagreement", () => {
    expect(parallelTheTitleAllows("Blue Refractor", "Black & White Red Ink"))
      .toEqual({ parallel: "Blue Refractor", vendorTagOverruled: "Black & White Red Ink" });
    // "shimmer" is absent from the Red Ink tag → not a subset → title wins.
    expect(parallelTheTitleAllows("Black White Shimmer Red Refractor", "Black & White Red Ink").parallel)
      .toBe("Black White Shimmer Red Refractor");
  });
  it("it does not let a bare colour inherit an unrelated numbered parallel", () => {
    // "Gold" is not a subset of "Blue Refractor" → still overruled.
    expect(parallelTheTitleAllows("Gold", "Blue Refractor").parallel).toBe("Gold");
  });
});

/**
 * CF-A-GOLD-SHIMMER-IS-NOT-A-GOLD (Drew, 2026-09-05). The stored damage that
 * prompted the ruling was written by the retired `ch-comp::` path, and these
 * pins prove the SURVIVING writers refuse to mint it again -- end to end, from
 * the real listing title through the parser to the vendor-tag decision, rather
 * than from a hand-written parallel string.
 *
 * The live row: sold_comps id
 * cardhedge::ch-comp::1778541264103x262828165280045280::2026-06-17T21:06:00.000Z::10250
 * title "2026 Bowman Marconi German 1st Auto CPA-MG Gold Shimmer /50 - Raw",
 * stored parallel "Gold" -- the shimmer dropped, the sale filed on the Gold
 * Refractor /50 pool beside a genuine $182.50 Gold Refractor.
 */
describe("a Gold Shimmer title is never written as a Gold", () => {
  const decide = (title: string, tag: string | null) => {
    const parsed = parseListingTitle(title);
    return parallelTheTitleAllows(parsed.parallel, tag, {
      variationMarker: parsed.variationMarker ?? null,
    });
  };

  it("the live German title reads Gold Shimmer and overrules the Gold tag", () => {
    const d = decide("2026 Bowman Marconi German 1st Auto CPA-MG Gold Shimmer /50 - Raw", "Gold");
    expect(d.parallel).toBe("Gold Shimmer");
    expect(d.vendorTagOverruled).toBe("Gold");
  });

  it("its two live siblings keep their shimmer too", () => {
    expect(decide("2026 Topps Bowman Chrome Gold Shimmer #CPA-MG Marconi German 1st Auto 30/50 DN43 - Raw", "Gold Refractor").parallel)
      .toBe("Gold Shimmer");
    expect(decide("2026 Bowman Baseball #CPA-MG Gold Shimmer Refractor", "Gold").parallel)
      .toBe("Gold Shimmer Refractor");
  });

  it("MUTATION: a Gold Refractor title is still a Gold Refractor", () => {
    // The genuine $182.50 sale sharing the pool. If the parser ever widened
    // "Gold" to swallow the shimmer sales, it would equally have to flatten
    // this one -- so pinning it is what makes the pair separable.
    const d = decide("2026 Bowman Marconi German Chrome Auto Gold Refractor 1st #/50 Nationals", "Gold");
    expect(d.parallel).toBe("Gold Refractor");
  });

  it("MUTATION: the colour alone is not the shimmer card", () => {
    // Two DIFFERENT cards, two price curves; neither name may read as the other.
    expect(parallelTheTitleAllows("Gold Shimmer", "Gold").parallel).toBe("Gold Shimmer");
    expect(parallelTheTitleAllows("Gold", "Gold Shimmer").parallel).toBe("Gold");
  });
});
