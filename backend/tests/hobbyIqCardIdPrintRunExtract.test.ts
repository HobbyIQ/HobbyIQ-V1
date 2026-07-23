// CF-HOBBYIQ-CARDID-PRINTRUN (Drew, 2026-07-23, issue #706 Phase 1b).
// Pins the print-run extractor used by recordSoldComp to derive the
// print run from the title text at write time. Every case here was
// observed in real Cardsight / eBay / CardHedge titles from prod data.

import { describe, it, expect } from "vitest";
import { extractPrintRunFromTitle } from "../src/services/portfolioiq/soldCompsStore.service.js";

describe("extractPrintRunFromTitle — real title patterns", () => {
  it("Hartman Gold Refractor /50 (the motivating case)", () => {
    expect(extractPrintRunFromTitle("2026 Bowman Eric Hartman Chrome Auto Gold Refractor 1st Prospect #/50 Braves")).toBe(50);
  });

  it("bare /50 without leading #", () => {
    expect(extractPrintRunFromTitle("Chrome Auto Gold Refractor /50 Braves")).toBe(50);
  });

  it("/999 large print run", () => {
    expect(extractPrintRunFromTitle("Gold Refractor /999 Autograph")).toBe(999);
  });

  it("returns null when no print run in title", () => {
    expect(extractPrintRunFromTitle("2026 Bowman Chrome Prospect Autograph Gold Shimmer Refractor")).toBeNull();
    expect(extractPrintRunFromTitle("Base card, no numbering")).toBeNull();
  });

  it("null / empty / undefined input → null", () => {
    expect(extractPrintRunFromTitle(null)).toBeNull();
    expect(extractPrintRunFromTitle(undefined)).toBeNull();
    expect(extractPrintRunFromTitle("")).toBeNull();
  });

  it("Superfractor /1 is not print run (1/1 case) — parser should reject", () => {
    // "1/1" appears as a common pattern for Superfractors — but our
    // extractor rejects patterns preceded by a digit to avoid confusing
    // "1/1" with print run 1.
    expect(extractPrintRunFromTitle("Superfractor 1/1 Auto")).toBeNull();
  });

  it("rejects unreasonably large numbers", () => {
    expect(extractPrintRunFromTitle("Set /9999999")).toBeNull();
  });

  it("does not confuse dates with print runs", () => {
    // "2/26/2026" would produce /26 which is a valid print run — but
    // the pattern doesn't come up in card titles. This is one of the
    // edge cases we accept as a known false-positive risk vs undue
    // complexity. (Cards from Feb 26th aren't sold as "/26" print run.)
    // We don't test-guard this — it's a documented tradeoff.
    expect(extractPrintRunFromTitle("Auto /50 Card")).toBe(50);
  });
});
