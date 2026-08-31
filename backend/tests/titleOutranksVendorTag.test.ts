import { describe, it, expect } from "vitest";
import { parallelTheTitleAllows } from "../src/services/portfolioiq/titleOutranksVendorTag.js";

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
