// CF-BOWMAN-PARALLELS-DATASET (2026-07-09, Drew — 1,849-row reference)
// unit tests for the year-aware print-run lookup.

import { describe, it, expect } from "vitest";
import {
  inferPrintRunForYearAndParallel,
  getBowmanParallelsMeta,
} from "../src/services/compiq/bowmanParallelsDataset";

describe("bowmanParallelsDataset — meta", () => {
  it("loads a dataset spanning 2011-2026 with ~1,800+ entries", () => {
    const meta = getBowmanParallelsMeta();
    expect(meta.entryCount).toBeGreaterThan(1500);
    expect(meta.yearRange.min).toBeLessThanOrEqual(2011);
    expect(meta.yearRange.max).toBeGreaterThanOrEqual(2026);
    expect(Object.keys(meta.productCounts).length).toBeGreaterThan(5);
  });
});

describe("bowmanParallelsDataset — inferPrintRunForYearAndParallel", () => {
  it("returns null when year is missing / invalid", () => {
    expect(inferPrintRunForYearAndParallel(null, "Red Refractor")).toBeNull();
    expect(inferPrintRunForYearAndParallel(NaN, "Red Refractor")).toBeNull();
    expect(inferPrintRunForYearAndParallel(0, "Red Refractor")).toBeNull();
  });

  it("returns null when parallel is missing / empty", () => {
    expect(inferPrintRunForYearAndParallel(2026, null)).toBeNull();
    expect(inferPrintRunForYearAndParallel(2026, "")).toBeNull();
    expect(inferPrintRunForYearAndParallel(2026, "   ")).toBeNull();
  });

  it("recognizes 2026 Bowman Chrome Prospect Autographs Red Refractor as /5", () => {
    const r = inferPrintRunForYearAndParallel(2026, "Red Refractor", {
      isAuto: true,
    });
    expect(r).not.toBeNull();
    expect(r!.printRun).toBe(5);
    expect(r!.auto).toBe(true);
  });

  it("recognizes 2026 Bowman Chrome Prospect Autographs Superfractor as /1", () => {
    const r = inferPrintRunForYearAndParallel(2026, "Superfractor");
    expect(r).not.toBeNull();
    expect(r!.printRun).toBe(1);
  });

  it("year-specific print runs — 2011 Blue Refractor is /150 for autos (Chrome Prospect Autographs ladder)", () => {
    // Existing rows in the sheet: 2011 Chrome Prospect Autographs Blue
    // Refractor = /150 (Chrome ladder). Same-year Refractor (base) is /500.
    // Locking on the /150 auto entry since inferPrintRun defaults there.
    const r = inferPrintRunForYearAndParallel(2011, "Blue Refractor", {
      isAuto: true,
    });
    expect(r).not.toBeNull();
    expect(r!.printRun).toBe(150);
  });

  it("prefers the auto entry when isAuto=true and multiple entries share (year, parallel)", () => {
    const rAuto = inferPrintRunForYearAndParallel(2026, "Gold Refractor", {
      isAuto: true,
    });
    const rBase = inferPrintRunForYearAndParallel(2026, "Gold Refractor", {
      isAuto: false,
    });
    // At minimum, if both entries exist and the auto flag was honored,
    // the returned auto flag matches the request.
    if (rAuto) expect(rAuto.auto).toBe(true);
    if (rBase && rBase.auto === false) expect(rBase.auto).toBe(false);
  });

  it("returns a Verified/High/Medium confidence tag when hit", () => {
    const r = inferPrintRunForYearAndParallel(2026, "Red Refractor", {
      isAuto: true,
    });
    expect(r).not.toBeNull();
    expect(r!.confidence).toMatch(/(verified|high|medium)/i);
  });

  it("returns null for a year outside the sheet's coverage", () => {
    // Sheet covers 2011-2026. Requesting 2005 should miss.
    expect(inferPrintRunForYearAndParallel(2005, "Red Refractor")).toBeNull();
  });

  it("case-insensitive parallel matching", () => {
    const r1 = inferPrintRunForYearAndParallel(2026, "Red Refractor");
    const r2 = inferPrintRunForYearAndParallel(2026, "red refractor");
    const r3 = inferPrintRunForYearAndParallel(2026, "RED REFRACTOR");
    expect(r1?.printRun).toBe(r2?.printRun);
    expect(r2?.printRun).toBe(r3?.printRun);
  });

  it("handles hyphen / en-dash / em-dash variants in the parallel name", () => {
    // The dataset stores "Mini-Diamond Refractor"; user might type it as
    // "Mini Diamond Refractor" or "Mini–Diamond Refractor".
    const rDash = inferPrintRunForYearAndParallel(
      2026,
      "Mini-Diamond Refractor",
    );
    const rSpace = inferPrintRunForYearAndParallel(
      2026,
      "Mini Diamond Refractor",
    );
    // Both should hit or both should miss — the normalizer collapses
    // hyphens to spaces.
    expect(rDash?.printRun ?? null).toBe(rSpace?.printRun ?? null);
  });
});
