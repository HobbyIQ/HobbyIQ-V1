// CF-SIBLING-CARD-FALLBACK (2026-07-06) — pins the last-resort price
// fallback for thin-market cards where CH has zero closed-sale comps
// at any grade. Concrete case: Eli Willits 2025 Bowman Draft Chrome
// Orange Auto — cardId resolves but no sales in the last 90 days.
//
// D4 PR 5 (2026-08-29): the seam obeys the empirical-only doctrine. The
// multiplier is the MEASURED premium or the rung returns null. Three
// hobby-consensus multipliers are gone and pinned gone below: the
// print-run floor (Orange /25 = 15x, Blue /150 = 3x, Gold /50 = 8x ...),
// the floor-only path (no measurement at all -> floor alone; the Marconi
// German $1,109), and the Base-card x 10x cross-class bridge. PSA 10 is
// Raw x getGraderPremium, not Raw x 8.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

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

/** The calibrated PSA 10 / Raw ratio the seam now uses instead of x8. */
const psa10Ratio = (rawPrice: number | null, isAuto: boolean, year: number, set: string) =>
  getGraderPremium("PSA", "10", rawPrice, isAuto ? "autograph" : "base", year, set);

function mockTable(entries: unknown[] | null): void {
  if (entries === null) {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    return;
  }
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ entries }));
}

const ORANGE_AUTO_2025_BCP = {
  year: 2025,
  set: "Bowman Chrome Prospects",
  parallel: "Orange",
  printRun: "(unspecified)",
  isAuto: true,
  baseRelativePremium: 4.364,
  sampleSize: 30,
  provenance: "empirical",
};

async function loadSeam() {
  const mod = await import("../src/services/compiq/siblingCardPriceFallback.service.js");
  mod._resetTableCacheForTesting();
  return mod;
}

async function chMocks() {
  return await import("../src/services/compiq/cardhedge.client.js");
}

describe("CF-SIBLING-CARD-FALLBACK — attemptSiblingPriceFallback", () => {
  it("returns null when the parallel-premiums table is missing — even for a known-rare parallel (the floor is gone)", async () => {
    // Pre-D4-PR-5 this returned an estimate for "Orange": no table, but
    // Orange matched the /25 tier so the 15x floor stood in for the
    // measurement. No measurement now means no price.
    mockTable(null);
    const { attemptSiblingPriceFallback } = await loadSeam();
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

  it("returns null when no premium entry matches the (year, set, parallel, isAuto)", async () => {
    mockTable([
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
    ]);
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Some Unknown Parallel",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).toBeNull();
  });

  it("MARCONI GERMAN SHAPE: a tiered parallel with NO measurement gets NO price — the floor-only path is retired", async () => {
    // The $1,109 estimate was "8.00x parallel (floor lifted from 1.00x)":
    // Gold /50 had no measured premium, so the seam used the /50 tier
    // floor ALONE. Same shape as the 2024 Blue Refractor auto that
    // CF-FLOOR-ONLY-WHEN-EMPIRICAL-MISSING was written for. Both now null.
    mockTable([
      {
        year: 2019,
        set: "Some Other Set",
        parallel: "Refractor",
        printRun: "(unspecified)",
        isAuto: true,
        baseRelativePremium: 2.5,
        sampleSize: 30,
        provenance: "empirical",
      },
    ]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "german-base-auto",
        player: "Marconi German",
        set: "2026 Bowman Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
        title: "Marconi German 2026 Bowman Chrome Prospect Autographs Baseball",
      } as any,
    ]);
    vi.mocked(getCardSales).mockResolvedValue([
      { price: 138, date: new Date().toISOString(), sale_type: "auction" },
      { price: 139, date: new Date().toISOString(), sale_type: "auction" },
      { price: 140, date: new Date().toISOString(), sale_type: "auction" },
    ] as any);
    const { attemptSiblingPriceFallback } = await loadSeam();
    for (const parallel of ["Gold Refractor", "Blue Refractor"]) {
      const result = await attemptSiblingPriceFallback({
        targetCardId: "target",
        year: 2026,
        set: "Bowman Chrome",
        parallel,
        isAuto: true,
        playerName: "Marconi German",
      });
      expect(result, parallel).toBeNull();
    }
    // The seam never even asked CH for a sibling: no multiplier, no search.
    expect(searchCards).not.toHaveBeenCalled();
  });

  it("uses Bowman Chrome Prospects as a same-year proxy when the exact set has no auto entry — and the MEASURED premium is the multiplier", async () => {
    mockTable([ORANGE_AUTO_2025_BCP]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling-base-auto",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
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
    const { attemptSiblingPriceFallback } = await loadSeam();
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
    expect(result!.premiumSampleSize).toBe(30);
    // The measured 4.364x. Pre-D4-PR-5 the /25 floor lifted this to 15x.
    expect(result!.parallelPremium).toBeCloseTo(4.364, 3);
    expect(result!.empiricalPremium).toBeCloseTo(4.364, 3);
    expect(result).not.toHaveProperty("floorApplied");
    expect(result!.inferredPrintRun).toBe(25);
    expect(result!.siblingCardId).toBe("sibling-base-auto");
    expect(result!.siblingCompCount).toBe(3);
    // Sibling median = $100 (3 sales at $95/$100/$105). No trajectory rate
    // -> projected today = $100. $100 x 4.364 = $436.40
    expect(result!.siblingBaseMedianRaw).toBeCloseTo(100, 0);
    expect(result!.siblingBaseProjectedToday).toBeCloseTo(100, 0);
    expect(result!.estimatedRawPrice).toBeCloseTo(436.4, 1);
    // PSA 10 = Raw x the calibrated grader premium (not x8).
    const ratio = psa10Ratio(436.4, true, 2025, "Bowman Draft Chrome");
    expect(ratio).not.toBe(8);
    expect(result!.estimatedPSA10Price).toBeCloseTo(Math.round(436.4 * ratio * 100) / 100, 1);
    // No rate -> no Predicted 7d
    expect(result!.estimatedRawPredicted7d).toBeNull();
    expect(result!.siblingIsCrossClass).toBe(false);
    expect(result!.crossClassAutoPremium).toBeNull();
  });

  it("CF-SIBLING-PICKER-SURNAME-GUARD: skips a CH-mislabeled sibling (player field says X but title says Y)", async () => {
    // CH has rows where player="Ethan Conrad" but title="Gavin Fien 2025
    // Bowman Draft Chrome ...". Picking the first `targetIsBase` match
    // would multiply Fien's median as Conrad's price. Guard: prefer
    // candidates whose title/name/subset contains the target's surname.
    mockTable([ORANGE_AUTO_2025_BCP]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "mislabeled-fien-as-conrad",
        player: "Ethan Conrad",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
        title: "Gavin Fien 2025 Bowman Draft Chrome Prospect Autographs Baseball",
      } as any,
      {
        card_id: "actual-conrad",
        player: "Ethan Conrad",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
        title: "Ethan Conrad 2025 Bowman Draft Chrome Prospect Autographs Baseball",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (cardId, grade) => {
      if (grade === "Raw" && cardId === "actual-conrad") {
        return [
          { price: 200, date: new Date().toISOString(), sale_type: "auction" },
          { price: 200, date: new Date().toISOString(), sale_type: "auction" },
          { price: 200, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      if (grade === "Raw" && cardId === "mislabeled-fien-as-conrad") {
        return [
          { price: 50, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-conrad-orange",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Ethan Conrad",
    });
    expect(result).not.toBeNull();
    expect(result!.siblingCardId).toBe("actual-conrad");
    expect(result!.siblingBaseMedianRaw).toBeCloseTo(200, 0);
    // $200 median x measured 4.364x = $872.80
    expect(result!.estimatedRawPrice).toBeCloseTo(872.8, 1);
  });

  it("CF-SIBLING-PICKER-SURNAME-GUARD: falls back gracefully when no candidate has surname in title (short surnames or empty text fields)", async () => {
    mockTable([ORANGE_AUTO_2025_BCP]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "conrad-no-text-fields",
        player: "Ethan Conrad",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 100, date: new Date().toISOString(), sale_type: "auction" },
        ] as any;
      }
      return [];
    });
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-conrad-orange",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Ethan Conrad",
    });
    expect(result).not.toBeNull();
    expect(result!.siblingCardId).toBe("conrad-no-text-fields");
    expect(result!.siblingCompCount).toBe(1);
  });

  it("CF-SIBLING-PROXY-SET-BREADTH: falls through to Bowman Draft when Bowman Chrome Prospects has no entry (real Willits case)", async () => {
    mockTable([
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
    ]);
    const { searchCards, getCardSales } = await chMocks();
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
    const { attemptSiblingPriceFallback } = await loadSeam();
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
    expect(result!.premiumMatchedSet).toBe("Bowman Draft");
    expect(result!.parallelPremium).toBeCloseTo(4.364, 3);
    expect(result!.empiricalPremium).toBeCloseTo(4.364, 3);
    expect(result!.inferredPrintRun).toBe(25);
    // $173 x 4.364 = $754.97 (was $2,595 under the 15x floor)
    expect(result!.estimatedRawPrice).toBeCloseTo(754.97, 1);
  });

  it("returns null when the sibling has no comps at Raw OR PSA 10", async () => {
    mockTable([ORANGE_AUTO_2025_BCP]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
    vi.mocked(getCardSales).mockResolvedValue([]);
    const { attemptSiblingPriceFallback } = await loadSeam();
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

  it("falls back to PSA 10 comps translated through the calibrated PSA 10 premium when the sibling has no Raw comps", async () => {
    mockTable([{ ...ORANGE_AUTO_2025_BCP, baseRelativePremium: 4.0 }]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "sibling",
        player: "Eli Willits",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "Prospect Autographs",
      } as any,
    ]);
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
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
    });
    expect(result).not.toBeNull();
    const ratio = psa10Ratio(null, true, 2025, "Bowman Draft Chrome");
    expect(ratio).toBeGreaterThan(1);
    // The weighted median of the three slab sales sits near $800; implied
    // Raw = median / ratio (was median / 8), then x the measured 4.0.
    const impliedRaw = result!.siblingBaseMedianRaw;
    expect(impliedRaw).toBeGreaterThan(700 / ratio);
    expect(impliedRaw).toBeLessThan(900 / ratio);
    expect(result!.siblingCompCount).toBe(3);
    expect(result!.estimatedRawPrice).toBeCloseTo(Math.round(impliedRaw * 4.0 * 100) / 100, 1);
  });

  it("D4 PR 5: an auto target with only a Base CARD sibling gets NO price — the x10 cross-class bridge is retired", async () => {
    // CF-SIBLING-BASE-CARD-FALLBACK used to anchor on the Base card and
    // multiply by a flat 10x "auto-over-base premium" ($5 x 10 x 15 = $750).
    // A hobby-consensus multiplier; honest silence now.
    mockTable([ORANGE_AUTO_2025_BCP]);
    const { searchCards, getCardSales } = await chMocks();
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "star-base-card",
        player: "Mike Trout",
        set: "2025 Bowman Draft Chrome",
        variant: "Base",
        subset: "",
      } as any,
    ]);
    vi.mocked(getCardSales).mockResolvedValue([
      { price: 5, date: new Date().toISOString(), sale_type: "auction" },
    ] as any);
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-orange-auto",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Mike Trout",
    });
    expect(result).toBeNull();
    expect(getCardSales).not.toHaveBeenCalled();
  });

  it("CF-SIBLING-NON-AUTO-COVERAGE: fires for non-auto rare parallels (Orange /25 base card) on the measured premium", async () => {
    mockTable([
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
    ]);
    const { searchCards, getCardSales } = await chMocks();
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
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target-orange-base",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: false,
      playerName: "Some Prospect",
    });
    expect(result).not.toBeNull();
    expect(result!.siblingIsCrossClass).toBe(false);
    expect(result!.parallelPremium).toBeCloseTo(23.181, 2);
    expect(result!.estimatedRawPrice).toBeCloseTo(23.18, 1);
  });

  it("trend-anchors: projects sibling median forward to today using rate before multiplying", async () => {
    // Willits Base Auto median $75, newest sale 21 days ago (3 weeks).
    // Matched-cohort +10%/wk -> sibling projected today = $75 x 1.30 =
    // $97.50; x measured 4.364 = $425.49; predicted 7d = x 1.10 = $468.04.
    mockTable([ORANGE_AUTO_2025_BCP]);
    const { searchCards, getCardSales } = await chMocks();
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
    const { attemptSiblingPriceFallback } = await loadSeam();
    const result = await attemptSiblingPriceFallback({
      targetCardId: "target",
      year: 2025,
      set: "Bowman Draft Chrome",
      parallel: "Orange",
      isAuto: true,
      playerName: "Eli Willits",
      trajectoryRateWeekly: 0.10,
    });
    expect(result).not.toBeNull();
    expect(result!.siblingBaseMedianRaw).toBeCloseTo(75, 0);
    expect(result!.siblingBaseProjectedToday).toBeCloseTo(97.5, 1);
    expect(result!.siblingWeeksSinceNewestSale).toBeCloseTo(3, 1);
    expect(result!.estimatedRawPrice).toBeCloseTo(425.49, 1);
    expect(result!.estimatedRawPredicted7d).toBeCloseTo(468.04, 1);
  });
});
