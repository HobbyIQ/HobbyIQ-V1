/**
 * CF-COMPIQ-PER-GRADE-BREAKDOWN — pin buildGradeBreakdownRow.
 *
 * Pure function that decides which of the 3 modes fires:
 *   live      — 3+ comps → medianPrice is FMV
 *   projected — 0 comps + Raw anchor → Raw × grader premium
 *   no-data   — 0 comps + no anchor
 */

import { describe, it, expect } from "vitest";
import { buildGradeBreakdownRow } from "../src/services/compiq/perGradeBreakdown.service";
import type { CardHedgeSale } from "../src/services/compiq/cardhedge.client";

function sale(price: number, date: string, title = "Test Card"): CardHedgeSale {
  return { price, date, grade: "Raw", source: "ebay", sale_type: "Auction", title, url: null };
}

const RAW_GRADE = { label: "Raw", gradingCompany: null, gradeValue: null };
const PSA_10 = { label: "PSA 10", gradingCompany: "PSA", gradeValue: 10 };

describe("buildGradeBreakdownRow — live mode", () => {
  it("3+ comps → source=live, FMV = median", () => {
    const row = buildGradeBreakdownRow(
      RAW_GRADE,
      { comps: [sale(20, "2026-06-25"), sale(22, "2026-06-20"), sale(18, "2026-06-15")], dailyPriceCount: 3 },
      null,
    );
    expect(row.source).toBe("live");
    expect(row.compCount).toBe(3);
    expect(row.fairMarketValue).toBe(20); // median
    expect(row.predictedPrice).toBe(20);
    expect(row.attribution.mechanism).toBe("live-comps");
    expect(row.recentComps.length).toBe(3);
  });

  it("comps sorted by date DESC in recentComps", () => {
    const row = buildGradeBreakdownRow(
      RAW_GRADE,
      { comps: [sale(15, "2026-06-01"), sale(20, "2026-06-25"), sale(18, "2026-06-15")], dailyPriceCount: 3 },
      null,
    );
    expect(row.recentComps.map((c) => c.date)).toEqual(["2026-06-25", "2026-06-15", "2026-06-01"]);
    expect(row.latestPrice).toBe(20);
    expect(row.latestDate).toBe("2026-06-25");
  });

  it("caps recentComps at 5 even when many comps exist", () => {
    const many = Array.from({ length: 20 }, (_, i) => sale(20 + i, `2026-06-${String(20 - i).padStart(2, "0")}`));
    const row = buildGradeBreakdownRow(RAW_GRADE, { comps: many, dailyPriceCount: 20 }, null);
    expect(row.recentComps.length).toBe(5);
    expect(row.compCount).toBe(20);
  });
});

describe("buildGradeBreakdownRow — projected mode", () => {
  it("PSA 10 with 0 comps but Raw anchor → source=projected via grader premium", () => {
    const row = buildGradeBreakdownRow(
      PSA_10,
      { comps: [], dailyPriceCount: 0 },
      { price: 100, cardYear: 2024, isAutograph: false },
    );
    expect(row.source).toBe("projected");
    expect(row.attribution.mechanism).toBe("grade-ladder-projection");
    expect(row.attribution.anchorGrade).toBe("Raw");
    expect(row.attribution.anchorPrice).toBe(100);
    expect(row.attribution.multiplier).toBeGreaterThan(1); // PSA 10 > Raw
    expect(row.predictedPrice).toBeGreaterThan(100);
    expect(row.fairMarketValue).toBeNull(); // FMV null on projected
  });

  it("projected has a range (±20% or ±1)", () => {
    const row = buildGradeBreakdownRow(
      PSA_10,
      { comps: [], dailyPriceCount: 0 },
      { price: 100, cardYear: 2024, isAutograph: false },
    );
    expect(row.predictedPriceRange).not.toBeNull();
    expect(row.predictedPriceRange!.low).toBeLessThan(row.predictedPrice!);
    expect(row.predictedPriceRange!.high).toBeGreaterThan(row.predictedPrice!);
  });

  it("thin comps (< 3) with Raw anchor also fall through to projected", () => {
    const row = buildGradeBreakdownRow(
      PSA_10,
      { comps: [sale(50, "2026-06-25")], dailyPriceCount: 1 },
      { price: 100, cardYear: 2024, isAutograph: false },
    );
    // Only 1 comp — insufficient for live; falls through to projected
    expect(row.source).toBe("projected");
    expect(row.compCount).toBe(1);
    expect(row.recentComps.length).toBe(1); // still exposed for iOS to show
    expect(row.medianPrice).toBe(50); // exposed for reference
  });
});

describe("buildGradeBreakdownRow — no-data mode", () => {
  it("PSA 10 with 0 comps AND no Raw anchor → source=no-data", () => {
    const row = buildGradeBreakdownRow(PSA_10, { comps: [], dailyPriceCount: 0 }, null);
    expect(row.source).toBe("no-data");
    expect(row.fairMarketValue).toBeNull();
    expect(row.predictedPrice).toBeNull();
    expect(row.confidence).toBe(0.1);
  });

  it("Raw with 0 comps → source=no-data (Raw can't project from itself)", () => {
    const row = buildGradeBreakdownRow(RAW_GRADE, { comps: [], dailyPriceCount: 0 }, null);
    expect(row.source).toBe("no-data");
    expect(row.predictedPrice).toBeNull();
  });
});

describe("buildGradeBreakdownRow — filter invalid inputs", () => {
  it("drops comps with non-positive prices from all counts", () => {
    const row = buildGradeBreakdownRow(
      RAW_GRADE,
      {
        comps: [sale(20, "2026-06-25"), sale(0, "2026-06-24"), sale(-5, "2026-06-23") as unknown as CardHedgeSale],
        dailyPriceCount: 1,
      },
      null,
    );
    // Only the valid comp — 1 remains, source=no-data (needs 3+ for live), no anchor for projected
    expect(row.compCount).toBe(1);
    expect(row.source).toBe("no-data");
  });
});
