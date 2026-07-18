// CF-BACKTEST-ACCURACY (Drew, 2026-07-17). Orchestration: read
// per-cardId valuation histories + real sales, join into pairs, feed
// into computeBacktestAccuracy.
//
// Scope: user-specific — reads the user's inventory, then joins
// against per-cardId valuation snapshots + sold_comps. Global
// backtest across all cardIds is a follow-up (requires a sampling
// strategy to avoid a full cross-partition scan).

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type {
  PredictionActualPair,
  BacktestAccuracyResult,
} from "./backtestAccuracyCompute.service.js";
import { computeBacktestAccuracy } from "./backtestAccuracyCompute.service.js";

const DEFAULT_WINDOW_DAYS = 90;
const MIN_SALE_WINDOW_DAYS = 3;    // ignore same-day sales (indistinguishable)
const MAX_SALE_WINDOW_DAYS = 30;   // sales further than 30d after snapshot don't count
const CONCURRENCY = 5;

async function mapBounded<T, R>(items: T[], limit: number, fn: (i: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

/** For a single cardId, join snapshot history with subsequent sales
 *  into (snapshot → next-sale-within-window) pairs. */
async function pairsForCard(cardId: string, windowDays: number): Promise<PredictionActualPair[]> {
  const [{ readValuationHistory }, { readCompsByCardId }] = await Promise.all([
    import("../portfolioiq/cardValuationHistoryStore.service.js"),
    import("../portfolioiq/soldCompsStore.service.js"),
  ]);

  const now = new Date();
  const fromDate = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const [snapshots, comps] = await Promise.all([
    readValuationHistory({ cardId, fromDate }),
    readCompsByCardId({
      cardId,
      fromDate: new Date(now.getTime() - windowDays * 86_400_000).toISOString(),
    }),
  ]);
  if (snapshots.length === 0 || comps.length === 0) return [];

  const compsByDate = comps
    .map((c) => ({ date: c.soldAt.slice(0, 10), price: c.price, sortKey: c.soldAt }))
    .filter((c) => Number.isFinite(c.price) && c.price > 0)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const pairs: PredictionActualPair[] = [];
  for (const snap of snapshots) {
    if (snap.predictedPrice === null || snap.predictedPrice <= 0) continue;
    const snapMs = new Date(snap.date + "T00:00:00Z").getTime();
    // Find the next sale within [MIN, MAX] days
    for (const sale of compsByDate) {
      const saleMs = new Date(sale.date + "T00:00:00Z").getTime();
      const daysBetween = Math.round((saleMs - snapMs) / 86_400_000);
      if (daysBetween < MIN_SALE_WINDOW_DAYS) continue;
      if (daysBetween > MAX_SALE_WINDOW_DAYS) break;
      pairs.push({
        cardId,
        snapshotDate: snap.date,
        predictedPrice: snap.predictedPrice,
        actualSalePrice: sale.price,
        actualSaleDate: sale.date,
        daysBetween,
      });
      break;   // one match per snapshot — the earliest qualifying sale
    }
  }
  return pairs;
}

export async function runBacktest(
  holdings: PortfolioHolding[],
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<BacktestAccuracyResult> {
  const cardIds = [
    ...new Set(
      holdings
        .map((h) => (h.cardId ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (cardIds.length === 0) {
    return computeBacktestAccuracy([], windowDays);
  }
  const perCardPairs = await mapBounded(cardIds, CONCURRENCY, (cardId) =>
    pairsForCard(cardId, windowDays).catch(() => []),
  );
  const allPairs = perCardPairs.flat();
  return computeBacktestAccuracy(allPairs, windowDays);
}
