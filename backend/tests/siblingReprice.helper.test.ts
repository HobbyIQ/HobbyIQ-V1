// CF-SIBLING-FALLBACK-WIRE-IN (Drew, 2026-07-28). Pins the grade-tier
// mapping so a wrong-grade sibling result never lands as a real FMV on
// the wrong tier — the empirical-only doctrine says "no defensible
// multiplier for arbitrary grades" so we return null and skip.

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
  });
});

describe("siblingEstimateBasis", () => {
  it("formats a plain sibling estimate", () => {
    const s = siblingEstimateBasis({
      siblingCardId: "ch-abc-123",
      siblingParallel: "Base",
      parallelPremium: 5.5,
      empiricalPremium: 5.5,
      floorApplied: false,
      siblingIsCrossClass: false,
    });
    expect(s).toBe("sibling: ch-abc-123 × 5.50× parallel");
  });

  it("notes when the print-run floor lifted the empirical premium", () => {
    const s = siblingEstimateBasis({
      siblingCardId: "ch-abc-123",
      siblingParallel: "Base",
      parallelPremium: 15,
      empiricalPremium: 4.4,
      floorApplied: true,
      siblingIsCrossClass: false,
    });
    expect(s).toContain("floor lifted from 4.40×");
  });

  it("notes when a cross-class fall (base card → auto target) was used", () => {
    const s = siblingEstimateBasis({
      siblingCardId: "ch-abc-123",
      siblingParallel: "Base",
      parallelPremium: 15,
      empiricalPremium: 15,
      floorApplied: false,
      siblingIsCrossClass: true,
    });
    expect(s).toContain("cross-class");
  });
});
