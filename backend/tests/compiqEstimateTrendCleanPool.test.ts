/**
 * CF-TREND-DIRTY-POOL (2026-06-08) — regression test.
 *
 * Pre-fix: computeCardTrajectory + fetchBroaderTrend.exactComps consumed
 * `fetched.comps` UNFILTERED. EXCLUSION_KEYWORDS hits (damaged, "(as is)",
 * lot, etc.) and outlier prices dragged the trend medians while the FMV
 * pipeline computed on the clean (post-applyCompQualityFilter) pool.
 *
 * Post-fix: caller in compiqEstimate.service.ts threads the
 * applyCompQualityFilter result (junk-excluded, full-date pool, variants
 * retained) into both trend surfaces.
 *
 * This test exercises the contract via computeEstimate end-to-end with a
 * mocked Cardsight pricing response carrying a DIRTY + CLEAN mixed pool.
 * Assertion: trendIQ.cardTrajectory.recentMedian matches the clean median,
 * not the dirty-inclusive one.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getPricing: vi.fn() };
});

vi.mock("../src/services/compiq/cardsight.router.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    findCompsRouted: vi.fn(),
    getCardSalesRouted: vi.fn(),
    searchCardsRouted: vi.fn(),
  };
});

// fetchSiblingSales hits the network for the broader-trend sibling pool.
// Force a deterministic empty pool so cardTrajectory is the load-bearing
// trend surface — that's the one we're asserting on here. Mocking the
// downstream compsByPlayer service is sufficient because fetchSiblingSales
// invokes it directly.
vi.mock("../src/services/compiq/compsByPlayer.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCompsByPlayer: vi.fn().mockResolvedValue({
      cards: [],
      comps: [],
      warnings: [],
      cached: false,
      elapsedMs: 0,
    }),
  };
});

import { computeEstimate } from "../src/services/compiq/compiqEstimate.service";
import { testCallContext } from "./_helpers/testCallContext.js";
import * as cardSight from "../src/services/compiq/cardsight.client.js";

describe("CF-TREND-DIRTY-POOL — junk-excluded pool feeds cardTrajectory", () => {
  const PINNED_ID = "fda530ab-e925-460e-ab88-63199ef975e9";

  beforeAll(() => {
    process.env.CARDSIGHT_API_KEY = "test-cardsight-key";
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dirty 14d listings excluded from cardTrajectory.recentMedian", async () => {
    const today = new Date();
    const isoDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

    // Build a mixed pool:
    //   - 14d window (recent): 5 CLEAN sales clustered around $420, plus 3
    //     DIRTY sales ($40-50, damaged/as-is/lot). simpleMedian on the
    //     full 8-comp pool would land ~$200 (the dirty entries pull it
    //     well below the clean cluster). On the cleaned 5-comp pool it
    //     lands at the clean cluster center (~$420).
    //   - 15-45d window (older): 5 CLEAN sales around $400 so the older
    //     median is a sane comparison baseline. No dirty entries here —
    //     keeps the older-median deterministic.
    const recentClean = [410, 415, 420, 425, 430].map((price, i) => ({
      title: `2011 Topps Update Mike Trout US175 RC #${i}`,
      price,
      date: isoDaysAgo(2 + i),
      source: "ebay" as const,
      url: null,
    }));
    const recentDirty = [
      { title: "2011 Topps Update Mike Trout US175 — damaged corner crease", price: 40 },
      { title: "Mike Trout US175 (as is) — please read description", price: 45 },
      { title: "Lot of Mike Trout cards including 2011 US175 RC", price: 50 },
    ].map((c, i) => ({ ...c, date: isoDaysAgo(8 + i), source: "ebay" as const, url: null }));

    const olderClean = [395, 400, 400, 405, 410].map((price, i) => ({
      title: `2011 Topps Update Mike Trout US175 RC #older-${i}`,
      price,
      date: isoDaysAgo(20 + i * 3),
      source: "ebay" as const,
      url: null,
    }));

    const allRecords = [...recentClean, ...recentDirty, ...olderClean];

    (cardSight.getPricing as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      card: {
        id: PINNED_ID,
        card_id: PINNED_ID,
        name: "Mike Trout",
        number: "US175",
        releaseName: "Topps Update",
        setName: "Base Set",
        year: 2011,
        player: "Mike Trout",
      },
      raw: { count: allRecords.length, records: allRecords },
      graded: [],
      meta: { total_records: allRecords.length, last_sale_date: allRecords[0].date },
    });

    const result = (await computeEstimate(
      { playerName: PINNED_ID, cardsightCardId: PINNED_ID } as any,
      testCallContext,
    )) as Record<string, any>;

    const trajectory = result?.trendIQ?.components?.cardTrajectory;
    expect(trajectory).toBeTruthy();

    // Cleaned recent median should land in the CLEAN cluster (~$420),
    // NOT the dirty-inclusive median (~$200). Allow ±$50 tolerance
    // around the clean cluster.
    expect(trajectory.recentMedian).toBeGreaterThan(370);
    expect(trajectory.recentMedian).toBeLessThan(470);

    // Cleaned recent count should reflect ONLY the clean recent comps
    // (5), not the full 8 (clean + dirty).
    expect(trajectory.recentCount).toBe(recentClean.length);

    // Direction: clean recent $420 ≈ clean older $400 → flat-to-up, not
    // the phantom-down that the dirty-pool bug produced.
    expect(["up", "flat"]).toContain(
      trajectory.pctChange > 3 ? "up" : trajectory.pctChange < -3 ? "down" : "flat",
    );
  });
});
