// CF-SIBLING-CARD-FALLBACK (2026-07-06) — pins the last-resort price
// fallback for thin-market cards where CH has zero closed-sale comps
// at any grade. Concrete case: Eli Willits 2025 Bowman Draft Chrome
// Orange Auto — cardId resolves but no sales in the last 90 days.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async (importActual) => {
  const actual = (await importActual()) as typeof import("node:fs");
  return { ...actual };
});

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(),
  getCardSales: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CF-SIBLING-CARD-FALLBACK — attemptSiblingPriceFallback", () => {
  it("returns null when the parallel-premiums table is missing / not loadable", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).toBeNull();
  });

  it("returns null when no premium entry matches", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          // A different year / set / parallel — no match
          {
            year: 2020,
            set: "Bowman Chrome",
            parallel: "Refractor",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 2.5,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).toBeNull();
  });

  it("uses Bowman Chrome Prospects as a proxy when the exact set has no auto entry", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          // No Bowman Draft Chrome Orange Auto — but Bowman Chrome Prospects
          // Orange Auto exists as a same-year proxy.
          {
            year: 2025,
            set: "Bowman Chrome Prospects",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 4.364,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    // Sibling search returns the player's Base Auto
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling-base-auto",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    // Sibling has Raw sales at $100 median
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 100, date: new Date().toISOString(), sale_type: "auction" },
          { price: 105, date: new Date().toISOString(), sale_type: "auction" },
          { price: 95,  date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });

    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).not.toBeNull();
    expect(result!.premiumUsedProxy).toBe(true);
    expect(result!.premiumMatchedSet).toBe("Bowman Chrome Prospects");
    // CF-PARALLEL-PREMIUM-FLOOR (2026-07-06): Orange = /25 tier → 15×
    // floor. Empirical 4.364 is below the floor, so effective is 15.
    expect(result!.parallelPremium).toBe(15);
    expect(result!.siblingCardId).toBe("sibling-base-auto");
    // Sibling median = $100 (from 3 sales at $95/$100/$105). No trajectory
    // rate provided → siblingBaseProjectedToday = $100. $100 × 15 = $1,500
    expect(result!.siblingBaseMedianRaw).toBeCloseTo(100, 0);
    expect(result!.siblingBaseProjectedToday).toBeCloseTo(100, 0);
    expect(result!.estimatedRawPrice).toBeCloseTo(1500, 0);
    // PSA 10 = Raw × 8
    expect(result!.estimatedPSA10Price).toBeCloseTo(12000, 0);
    // No rate → no Predicted 7d
    expect(result!.estimatedRawPredicted7d).toBeNull();
  });

  it("CF-SIBLING-PROXY-SET-BREADTH: falls through to Bowman Draft when Bowman Chrome Prospects has no entry (real Willits case)", async () => {
    // Empirical Willits scenario found via prod-data probe 2026-07-07:
    // - Target: 2025 Bowman Draft Chrome Orange Auto
    // - No exact-set entry (Orange has isAuto=false only for Bowman Draft Chrome)
    // - No Bowman Chrome Prospects Orange auto for 2025
    // - "Bowman Draft" DOES have 2025 Orange isAuto=true (n=30, 4.364×)
    // The pre-fix proxy only tried "bowman chrome prospects" — silently
    // bailed → sibling fallback returned null → Willits Orange Auto
    // showed "unavailable" on prod despite PR #303 shipping the floor.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          // Same-year Bowman Draft Chrome Orange BASE (not the auto)
          {
            year: 2025,
            set: "Bowman Draft Chrome",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: false,
            baseRelativePremium: 23.181,
            sampleSize: 26,
            provenance: "empirical",
          },
          // The critical entry that the proxy MUST reach
          {
            year: 2025,
            set: "Bowman Draft",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 4.364,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "willits-base-auto",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 173, date: new Date().toISOString(), sale_type: "auction" },
          { price: 173, date: new Date().toISOString(), sale_type: "auction" },
          { price: 173, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });
    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-willits-orange",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).not.toBeNull();
    expect(result!.premiumUsedProxy).toBe(true);
    expect(result!.premiumMatchedSet).toBe("Bowman Draft");   // ← the fix
    expect(result!.parallelPremium).toBe(15);                  // /25 floor lifts 4.364 → 15
    expect(result!.floorApplied).toBe(true);
    expect(result!.empiricalPremium).toBeCloseTo(4.364, 2);
    expect(result!.inferredPrintRun).toBe(25);
    // Sibling median = $173 × 15 = $2,595
    expect(result!.estimatedRawPrice).toBeCloseTo(2595, 0);
  });

  it("returns null when the sibling has no comps at Raw OR PSA 10", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Chrome Prospects",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 4.364,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    vi.mocked(getCardSales).mockResolvedValue([] as any);

    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).toBeNull();
  });

  it("falls back to PSA 10 comps ÷ 8 when the sibling has no Raw comps", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Chrome Prospects",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 4.0,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    // Raw empty; PSA 10 has sales at $800 — so implied Raw = $100
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "PSA 10") {
        return [
          { price: 800, date: new Date().toISOString(), sale_type: "auction" },
          { price: 780, date: new Date().toISOString(), sale_type: "buy it now" },
          { price: 820, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });

    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).not.toBeNull();
    // Implied sibling base: PSA 10 × 1 / 8 ≈ $100. Empirical premium 4.0
    // is below the /25 tier floor of 15 → effective premium 15.
    // Estimated Raw = $100 × 15 = $1,500
    expect(result!.siblingBaseMedianRaw).toBeCloseTo(100, 0);
    expect(result!.estimatedRawPrice).toBeCloseTo(1500, 0);
  });

  it("CF-SIBLING-BASE-CARD-FALLBACK: uses Base card + auto-premium when Base Auto is missing", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Chrome Prospects",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 4.364,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    // Only Base card returned — no Base Auto SKU exists for this player
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "star-base-card",
        player: "Mike Trout",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 5, date: new Date().toISOString(), sale_type: "auction" },
          { price: 5, date: new Date().toISOString(), sale_type: "buy it now" },
          { price: 5, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });
    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-orange-auto",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Mike Trout",
    });
    expect(result).not.toBeNull();
    expect(result!.siblingIsCrossClass).toBe(true);
    expect(result!.crossClassAutoPremium).toBe(10);
    // Base card $5 × 10 auto premium = $50 base-auto anchor
    // × 15 Orange /25 floor = $750 Raw estimate
    expect(result!.estimatedRawPrice).toBeCloseTo(750, 0);
  });

  it("CF-SIBLING-NON-AUTO-COVERAGE: fires for non-auto rare parallels (Orange /25 base card)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Draft Chrome",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: false,
            baseRelativePremium: 23.181,   // empirical base-card Orange premium
            sampleSize: 26,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "base-card-sibling",
        player: "Some Prospect",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 1, date: new Date().toISOString(), sale_type: "auction" },
          { price: 1, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });
    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-orange-base",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: false,   // ← non-auto target
      playerName: "Some Prospect",
    });
    expect(result).not.toBeNull();
    expect(result!.siblingIsCrossClass).toBe(false);
    // Empirical 23.181 IS above the /25 floor of 15 → uses empirical
    expect(result!.parallelPremium).toBeCloseTo(23.181, 2);
    // $1 base × 23.181 = ~$23.18
    expect(result!.estimatedRawPrice).toBeCloseTo(23.18, 1);
  });

  it("trend-anchors: projects sibling median forward to today using rate before multiplying", async () => {
    // Willits Base Auto median $75, newest sale 21 days ago (3 weeks).
    // Matched-cohort +10%/wk → sibling projected today = $75 × (1 + 0.10 × 3)
    // = $75 × 1.30 = $97.50. Orange /25 floor 15× → estimated Raw = $1,462.50.
    // Predicted 7d = $1,462.50 × (1 + 0.10 × 1) = $1,608.75
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Chrome Prospects",
            parallel: "Orange",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 4.364,
            sampleSize: 30,
            provenance: "empirical",
          },
        ],
      }),
    );
    const { searchCards, getCardSales } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString();
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 75, date: twentyOneDaysAgo, sale_type: "auction" },
          { price: 75, date: twentyOneDaysAgo, sale_type: "buy it now" },
          { price: 75, date: twentyOneDaysAgo, sale_type: "auction" },
        ] as any;
      }
      return [];
    });

    const { _resetTableCacheForTesting, attemptSiblingPriceFallback } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
      trajectoryRateWeekly: 0.10,   // matched-cohort says +10%/wk
    });
    expect(result).not.toBeNull();
    expect(result!.siblingBaseMedianRaw).toBeCloseTo(75, 0);
    // Projected today = 75 × (1 + 0.10 × 3) = 97.5
    expect(result!.siblingBaseProjectedToday).toBeCloseTo(97.5, 1);
    expect(result!.siblingWeeksSinceNewestSale).toBeCloseTo(3, 1);
    // × 15 (floor) = 1462.50
    expect(result!.estimatedRawPrice).toBeCloseTo(1462.5, 0);
    // × (1 + 0.10 × 1) = 1608.75
    expect(result!.estimatedRawPredicted7d).toBeCloseTo(1608.75, 0);
  });
});
