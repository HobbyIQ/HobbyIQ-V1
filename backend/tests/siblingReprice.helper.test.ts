// CF-SIBLING-FALLBACK-WIRE-IN (Drew, 2026-07-28). Pins the grade-tier
// mapping so a wrong-grade sibling result never lands as a real FMV on
// the wrong tier — the empirical-only doctrine says "no defensible
// multiplier for arbitrary grades" so we return null and skip.
//
// D4 PR 5 (2026-08-29): the basis note names the MEASUREMENT (premium,
// sample size, matched set). There is no floor clause any more because
// there is no floor.

import { describe, expect, it } from "vitest";
import {
  mapSiblingToRepriceFmv,
  siblingEstimateBasis,
} from "../src/services/portfolioiq/siblingReprice.helper.js";

const SIBLING = {
  estimatedRawPrice: 25,
  estimatedPSA10Price: 200,
};

describe("mapSiblingToRepriceFmv", () => {
  it("returns Raw price when the holding is raw (no gradeCompany)", () => {
    const r = mapSiblingToRepriceFmv(SIBLING, null, null);
    expect(r).toEqual({ grade: "raw", price: 25 });
  });

  it("returns Raw price when gradeCompany is empty string", () => {
    const r = mapSiblingToRepriceFmv(SIBLING, "", null);
    expect(r).toEqual({ grade: "raw", price: 25 });
  });

  it("returns PSA 10 price when the holding is PSA 10 exactly", () => {
    const r = mapSiblingToRepriceFmv(SIBLING, "PSA", 10);
    expect(r).toEqual({ grade: "psa-10", price: 200 });
  });

  it("case-insensitive on grade company", () => {
    const r = mapSiblingToRepriceFmv(SIBLING, "psa", 10);
    expect(r).toEqual({ grade: "psa-10", price: 200 });
  });

  it("returns null for PSA 9 (no defensible multiplier here)", () => {
    expect(mapSiblingToRepriceFmv(SIBLING, "PSA", 9)).toBeNull();
  });

  it("returns null for BGS 10 (near-equivalent to PSA 10 but different market)", () => {
    // Intentional: we skip rather than approximate. Empirical-only doctrine.
    expect(mapSiblingToRepriceFmv(SIBLING, "BGS", 10)).toBeNull();
  });

  it("returns null for SGC + CGC of any grade", () => {
    expect(mapSiblingToRepriceFmv(SIBLING, "SGC", 10)).toBeNull();
    expect(mapSiblingToRepriceFmv(SIBLING, "CGC", 10)).toBeNull();
    expect(mapSiblingToRepriceFmv(SIBLING, "SGC", 9)).toBeNull();
  });

  it("returns null when the applicable sibling field is zero or missing", () => {
    expect(mapSiblingToRepriceFmv({ estimatedRawPrice: 0, estimatedPSA10Price: 200 }, null, null)).toBeNull();
    expect(mapSiblingToRepriceFmv({ estimatedRawPrice: 25, estimatedPSA10Price: 0 }, "PSA", 10)).toBeNull();
    expect(mapSiblingToRepriceFmv({ estimatedRawPrice: 25, estimatedPSA10Price: null }, "PSA", 10)).toBeNull();
  });
});

describe("siblingEstimateBasis", () => {
  it("names the sibling, the measured premium and the measurement behind it", () => {
    const s = siblingEstimateBasis({
      siblingCardId: "ch-abc-123",
      parallelPremium: 5.5,
      premiumSampleSize: 30,
      premiumMatchedSet: "Bowman Chrome",
      premiumUsedProxy: false,
    });
    expect(s).toBe("sibling: ch-abc-123 × 5.50× parallel (empirical n=30, Bowman Chrome)");
  });

  it("says when the premium came from a brand-family proxy set", () => {
    const s = siblingEstimateBasis({
      siblingCardId: "ch-abc-123",
      parallelPremium: 4.364,
      premiumSampleSize: 30,
      premiumMatchedSet: "Bowman Draft",
      premiumUsedProxy: true,
    });
    expect(s).toBe("sibling: ch-abc-123 × 4.36× parallel (empirical n=30, Bowman Draft proxy)");
  });

  it("never mentions a floor — there is none", () => {
    const s = siblingEstimateBasis({
      siblingCardId: "ch-abc-123",
      parallelPremium: 1.2,
      premiumSampleSize: 7,
      premiumMatchedSet: "Bowman Chrome",
      premiumUsedProxy: false,
    });
    expect(s).not.toMatch(/floor/i);
  });
});
