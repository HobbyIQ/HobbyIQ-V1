/**
 * CardHedge implementation of PlayerTrendProvider.
 *
 * Adapts CH's `/cards/sales-stats-by-player` + `/cards/total-sales-by-player`
 * into the vendor-neutral shapes defined in playerTrend.types.ts.
 *
 * When we migrate to eBay-direct, this file gets a sibling
 * `ebayDirectProvider.ts` and the provider-selection layer swaps them.
 * Nothing else changes.
 */

import {
  getSalesStatsByPlayer,
  getTotalSalesByPlayer,
} from "../compiq/cardhedge.client.js";
import { computeMomentumFromNormalizedWeeks } from "./momentum.compute.js";
import { classifySupplyTrend } from "./supplyTrend.classify.js";
import type {
  NormalizedWeeklySales,
  PlayerTrendProvider,
  PlayerTrendSnapshot,
} from "./playerTrend.types.js";

const PROVIDER_NAME = "cardhedge";

export const cardHedgePlayerTrendProvider: PlayerTrendProvider = {
  name: PROVIDER_NAME,

  async getPlayerTrendSnapshot(
    playerName: string,
    weeksBack: number,
  ): Promise<PlayerTrendSnapshot | null> {
    if (!playerName || playerName.trim().length === 0) return null;
    const [stats, totals] = await Promise.all([
      getSalesStatsByPlayer([playerName], "week"),
      getTotalSalesByPlayer([playerName]),
    ]);

    if (!stats) return null; // provider unavailable (missing key / network fail)

    const playerResult = stats.results?.find((r) => r.player === playerName);
    if (!playerResult) return null;

    // Normalize CH's SalesStatsBucket into NormalizedWeeklySales.
    // Filter partial buckets — they include mid-week noise and pro-rated
    // averages. The current-week partial is included as-is only when the
    // caller explicitly asks (weeksBack > available complete weeks); the
    // momentum computation itself uses complete-only.
    const buckets: NormalizedWeeklySales[] = (playerResult.buckets ?? [])
      .filter((b) => !b.partial)
      .map((b) => ({
        weekStart: b.start,
        weekEnd: b.end,
        count: Number.isFinite(b.count) ? b.count : 0,
        totalDollars: Number.isFinite(b.total_amount) ? b.total_amount : 0,
        avgSale: Number.isFinite(b.average_sale) ? b.average_sale : 0,
      }))
      .slice(-Math.max(1, weeksBack));

    const momentum = computeMomentumFromNormalizedWeeks(buckets);
    const supplyTrend = classifySupplyTrend(momentum);

    const totalSales30d =
      totals?.results?.find((r) => r.player === playerName)?.total_sales ?? null;

    return {
      player: playerName,
      momentum,
      supplyTrend,
      totalSales30d,
      providerName: PROVIDER_NAME,
      capturedAtMs: Date.now(),
    };
  },
};
