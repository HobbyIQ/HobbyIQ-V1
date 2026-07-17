// CF-GRADE-WORTHY-FAMILY-BLENDING (Drew, 2026-07-17). Pinning tests
// for the family-multiplier fallback that unblocks thin-SKU cards.

import { describe, it, expect } from "vitest";
import {
  deriveFamilyKey,
  blendFamilyMultipliersIntoGraderPremiums,
} from "../src/services/portfolioiq/gradeWorthyAnalyze.service.js";
import type { GraderPremiumInput } from "../src/types/gradeWorthy.types.js";

describe("deriveFamilyKey", () => {
  it("strips leading year from 'YYYY <set>' shape", () => {
    expect(deriveFamilyKey("2026 Bowman Chrome Baseball")).toBe("bowman_chrome_baseball");
    expect(deriveFamilyKey("2025 Panini Prizm Baseball")).toBe("panini_prizm_baseball");
    expect(deriveFamilyKey("2026 Topps Baseball")).toBe("topps_baseball");
  });

  it("accepts a bare product name", () => {
    expect(deriveFamilyKey("Bowman Chrome")).toBe("bowman_chrome");
    expect(deriveFamilyKey("Topps")).toBe("topps");
  });

  it("handles YYYY-YY hyphen form", () => {
    expect(deriveFamilyKey("2024-25 Panini Prizm Basketball")).toBe("panini_prizm_basketball");
  });

  it("empty / whitespace → empty string", () => {
    expect(deriveFamilyKey("")).toBe("");
    expect(deriveFamilyKey("   ")).toBe("");
  });
});

describe("blendFamilyMultipliersIntoGraderPremiums", () => {
  const rawPrice = 100;

  it("synthesizes graded tier when local is missing entirely", () => {
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 12, meanPrice: 100, multiplierVsBaseline: 1 },
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "high" as const, nGraded: 47 },
    ];
    const { premiums, familyBlendedTiers } = blendFamilyMultipliersIntoGraderPremiums(
      local, rawPrice, family,
    );
    expect(premiums["PSA 10"]).toBeDefined();
    expect(premiums["PSA 10"].meanPrice).toBeCloseTo(540, 1); // 100 × 5.4
    expect(premiums["PSA 10"].n).toBe(47);
    expect(familyBlendedTiers).toEqual(["PSA 10"]);
  });

  it("skips family blend when local SKU has n >= 3 for the tier", () => {
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 12, meanPrice: 100, multiplierVsBaseline: 1 },
      "PSA 10": { n: 8, meanPrice: 900, multiplierVsBaseline: 9 }, // richer local data
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "high" as const, nGraded: 47 },
    ];
    const { premiums, familyBlendedTiers } = blendFamilyMultipliersIntoGraderPremiums(
      local, rawPrice, family,
    );
    // Local kept — meanPrice unchanged.
    expect(premiums["PSA 10"].meanPrice).toBe(900);
    expect(premiums["PSA 10"].n).toBe(8);
    expect(familyBlendedTiers).toEqual([]);
  });

  it("blends when local SKU tier has n < 3 (sparse)", () => {
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 12, meanPrice: 100, multiplierVsBaseline: 1 },
      "PSA 10": { n: 2, meanPrice: 1200, multiplierVsBaseline: 12 }, // sparse
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "high" as const, nGraded: 47 },
    ];
    const { premiums } = blendFamilyMultipliersIntoGraderPremiums(local, rawPrice, family);
    // Family blend takes over (100 × 5.4 = 540).
    expect(premiums["PSA 10"].meanPrice).toBeCloseTo(540, 1);
    expect(premiums["PSA 10"].n).toBe(47);
  });

  it("skips low-confidence family multipliers (would add noise)", () => {
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 12, meanPrice: 100, multiplierVsBaseline: 1 },
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "low" as const, nGraded: 6 },
    ];
    const { premiums, familyBlendedTiers } = blendFamilyMultipliersIntoGraderPremiums(
      local, rawPrice, family,
    );
    expect(premiums["PSA 10"]).toBeUndefined();
    expect(familyBlendedTiers).toEqual([]);
  });

  it("blends multiple tiers in a single call", () => {
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 12, meanPrice: 100, multiplierVsBaseline: 1 },
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "high" as const, nGraded: 47 },
      { graderTier: "PSA 9", multiplier: 2.3, confidence: "medium" as const, nGraded: 22 },
      { graderTier: "BGS 9.5", multiplier: 4.1, confidence: "high" as const, nGraded: 18 },
    ];
    const { premiums, familyBlendedTiers } = blendFamilyMultipliersIntoGraderPremiums(
      local, rawPrice, family,
    );
    expect(premiums["PSA 10"].meanPrice).toBeCloseTo(540);
    expect(premiums["PSA 9"].meanPrice).toBeCloseTo(230);
    expect(premiums["BGS 9.5"].meanPrice).toBeCloseTo(410);
    expect(familyBlendedTiers.sort()).toEqual(["BGS 9.5", "PSA 10", "PSA 9"]);
  });

  it("returns unchanged premiums when rawPrice is 0", () => {
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 0, meanPrice: 0, multiplierVsBaseline: 1 },
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "high" as const, nGraded: 47 },
    ];
    const { premiums, familyBlendedTiers } = blendFamilyMultipliersIntoGraderPremiums(
      local, 0, family,
    );
    expect(premiums["PSA 10"]).toBeUndefined();
    expect(familyBlendedTiers).toEqual([]);
  });

  it("Hartman-like case: raw only, no graded, family fills tiers", () => {
    // Hartman CPA-EHA Base Auto has ~226 raw sales in ch_daily_sales
    // but ZERO graded. Bowman Chrome Baseball family has strong graded data.
    const local: Record<string, GraderPremiumInput> = {
      "Raw": { n: 226, meanPrice: 108, multiplierVsBaseline: 1 },
    };
    const family = [
      { graderTier: "PSA 10", multiplier: 5.4, confidence: "high" as const, nGraded: 47 },
      { graderTier: "BGS 9.5", multiplier: 4.8, confidence: "medium" as const, nGraded: 18 },
    ];
    const { premiums, familyBlendedTiers } = blendFamilyMultipliersIntoGraderPremiums(
      local, 108, family,
    );
    // 108 × 5.4 = 583.20
    expect(premiums["PSA 10"].meanPrice).toBeCloseTo(583.2, 1);
    expect(premiums["BGS 9.5"].meanPrice).toBeCloseTo(518.4, 1);
    expect(familyBlendedTiers.sort()).toEqual(["BGS 9.5", "PSA 10"]);
  });
});
