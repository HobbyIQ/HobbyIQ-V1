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
    expect(result!.parallelPremium).toBe(4.364);
    expect(result!.siblingCardId).toBe("sibling-base-auto");
    // ~$100 base × 4.364 = ~$436.40
    expect(result!.estimatedRawPrice).toBeCloseTo(436.4, 0);
    // PSA 10 = Raw × 8
    expect(result!.estimatedPSA10Price).toBeCloseTo(3491.2, 0);
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
    // Implied sibling base: PSA 10 × 1 / 8 ≈ $100 → × 4.0 premium = $400
    expect(result!.siblingBasePrice).toBeCloseTo(100, 0);
    expect(result!.estimatedRawPrice).toBeCloseTo(400, 0);
  });
});
