// CF-MANUAL-IDENTITY-PRICING (2026-07-07) — pins the synthetic-identity
// pricing path that unblocks CH catalog gaps (Conrad Blue Refractor
// Auto, Hartman Blue Refractor Auto, Salas parallels).

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

vi.mock("../src/services/compiq/observedGradeCurve.service.js", async (importActual) => {
  const actual = (await importActual()) as typeof import(
    "../src/services/compiq/observedGradeCurve.service.js"
  );
  return {
    ...actual,
    deriveWeeklyRate: vi.fn(),
  };
});

vi.mock("../src/services/compiq/releaseDecayPrior.service.js", () => ({
  getReleaseDecayForCardAsync: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CF-MANUAL-IDENTITY-PRICING — priceByManualIdentity", () => {
  it("prices a CH-catalog-gap card via sibling fallback with trajectory rate applied", async () => {
    // Ethan Conrad CPA-EC Blue Refractor Auto — CH doesn't index this
    // SKU but has Conrad's Base Auto in the same set. Sibling fallback
    // must fire for the (year, set, parallel, isAuto) tuple alone.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Draft Chrome",
            parallel: "Blue Refractor",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 2.5,
            sampleSize: 40,
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
        card_id: "conrad-base-auto",
        player: "Ethan Conrad",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
        title: "Ethan Conrad 2025 Bowman Draft Chrome Prospect Autographs Baseball",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 150, date: new Date().toISOString(), sale_type: "auction" },
          { price: 155, date: new Date().toISOString(), sale_type: "auction" },
          { price: 145, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });

    const { deriveWeeklyRate } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    vi.mocked(deriveWeeklyRate).mockResolvedValue({
      cappedRate: 0.05,   // +5%/wk
      signalSource: "matched-cohort-cached",
    });

    const { _resetTableCacheForTesting } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();

    const { priceByManualIdentity } = await import(
      "../src/services/compiq/manualIdentityPricing.service.js"
    );
    const result = await priceByManualIdentity({
      year: 2025,
      set: "Bowman Draft Chrome",
      playerName: "Ethan Conrad",
      parallel: "Blue Refractor",
      isAuto: true,
    });

    expect(result).not.toBeNull();
    expect(result!.siblingFallback).not.toBeNull();
    expect(result!.siblingFallback!.siblingCardId).toBe("conrad-base-auto");
    // Blue Refractor /150 → 3× floor; empirical 2.5 lifts to 3
    expect(result!.siblingFallback!.parallelPremium).toBe(3);
    expect(result!.siblingFallback!.floorApplied).toBe(true);
    expect(result!.siblingFallback!.inferredPrintRun).toBe(150);
    // Sibling median $150 × 3× = $450
    expect(result!.estimatedRawPrice).toBeCloseTo(450, 0);
    expect(result!.trajectoryRateWeekly).toBeCloseTo(0.05, 3);
    expect(result!.signalSource).toBe("matched-cohort-cached");
    // Predicted 7d = $450 × 1.05 = $472.50
    expect(result!.estimatedRawPredicted7d).toBeCloseTo(472.5, 1);
    expect(result!.predictedPricePct).toBeCloseTo(5, 1);
  });

  it("returns null when sibling fallback bails out (thin-player, no anchor)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ entries: [] }),
    );
    const { searchCards } = await import(
      "../src/services/compiq/cardhedge.client.js"
    );
    vi.mocked(searchCards).mockResolvedValue([]);

    const { deriveWeeklyRate } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    vi.mocked(deriveWeeklyRate).mockResolvedValue(null);

    const { _resetTableCacheForTesting } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();

    const { priceByManualIdentity } = await import(
      "../src/services/compiq/manualIdentityPricing.service.js"
    );
    const result = await priceByManualIdentity({
      year: 2025,
      set: "Bowman Draft Chrome",
      playerName: "Unknown Prospect",
      parallel: "Blue Refractor",
      isAuto: true,
    });
    expect(result).toBeNull();
  });

  it("handles missing trajectory rate gracefully (still returns an estimate, no Predicted 7d)", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        entries: [
          {
            year: 2025,
            set: "Bowman Draft Chrome",
            parallel: "Blue Refractor",
            printRun: "(unspecified)",
            isAuto: true,
            baseRelativePremium: 2.5,
            sampleSize: 40,
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
        card_id: "conrad-base-auto",
        player: "Ethan Conrad",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
        title: "Ethan Conrad 2025 Bowman Draft Chrome Prospect Autographs Baseball",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 150, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });
    const { deriveWeeklyRate } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    vi.mocked(deriveWeeklyRate).mockResolvedValue(null);

    const { _resetTableCacheForTesting } = await import(
      "../src/services/compiq/siblingCardPriceFallback.service.js"
    );
    _resetTableCacheForTesting();

    const { priceByManualIdentity } = await import(
      "../src/services/compiq/manualIdentityPricing.service.js"
    );
    const result = await priceByManualIdentity({
      year: 2025,
      set: "Bowman Draft Chrome",
      playerName: "Ethan Conrad",
      parallel: "Blue Refractor",
      isAuto: true,
    });

    expect(result).not.toBeNull();
    expect(result!.estimatedRawPrice).toBeCloseTo(450, 0);
    expect(result!.trajectoryRateWeekly).toBeNull();
    expect(result!.signalSource).toBeNull();
    expect(result!.estimatedRawPredicted7d).toBeNull();
    expect(result!.predictedPricePct).toBeNull();
  });
});
