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
  it("the vendor can never add a finish the title lacks", () => {
    expect(parallelTheTitleAllows(null, "Refractor").parallel).toBeNull();
  });
});
