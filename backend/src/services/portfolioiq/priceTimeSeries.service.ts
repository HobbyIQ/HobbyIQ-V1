// CF-PRICE-TIME-SERIES (Drew, 2026-07-15): time-series aggregation over
// the sold_comps pool. Feeds iOS chart component + seasonality signals
// (buy/sell timing, YoY comparisons, peak-month detection).
//
// Reads: sold_comps container, partition-hit by cardId.
// Buckets: weekly / monthly / quarterly.
// Windows: 3m / 1y / 3y / all.
//
// Aggregation per bucket:
//   - count            (number of sales)
//   - medianPrice
//   - minPrice, maxPrice, meanPrice
//   - sourceBreakdown  ({source: count} — cardhedge/cardsight/user)
//
// Filters: source list, min-confidence, flaggedWrong exclusion (matches
// the engine's augmentCompsWithUserPool skip logic — moderation carries
// through to charts).
//
// CF-PRICE-HISTORY-CH-DAILY-MERGE (Drew, 2026-07-17): sold_comps is
// populated per-query (~1,500 rows total across all cards) and only
// spans the last few weeks. ch_daily_sales carries the full bulk-
// ingested pool (886k+ rows, 90d+ history). We merge both here so the
// chart shows the FULL history — iOS was rendering blank charts when
// sold_comps had only 2 weeks of data. Dedup by (cardId, saleDate,
// priceCents) since bulk + per-query can double-cover the same sale.

import { readCompsByCardId, type SoldCompDoc, type SoldCompSource } from "./soldCompsStore.service.js";
import { CosmosClient, type Container } from "@azure/cosmos";

export type PriceHistoryBucket = "weekly" | "monthly" | "quarterly";
export type PriceHistoryWindow = "3m" | "1y" | "3y" | "all";

export interface PriceHistoryBucketPoint {
  /** Bucket start ISO date (Sunday for weekly, 1st for monthly, quarter-start for quarterly). */
  bucketStart: string;
  count: number;
  medianPrice: number;
  minPrice: number;
  maxPrice: number;
  meanPrice: number;
  sourceBreakdown: Record<string, number>;
}

export interface PriceHistoryResult {
  cardId: string;
  window: PriceHistoryWindow;
  bucket: PriceHistoryBucket;
  totalComps: number;
  earliestSoldAt: string | null;
  latestSoldAt: string | null;
  points: PriceHistoryBucketPoint[];
}

/** Convert a window to a start-date ISO. For "all", returns an ancient
 *  date so we bypass readCompsByCardId's default 180d lower bound
 *  (that default was designed for hot-path FMV queries; time-series
 *  wants everything the pool has). */
function windowStartIso(window: PriceHistoryWindow, now: number = Date.now()): string {
  switch (window) {
    case "3m":  return new Date(now - 90 * 86_400_000).toISOString();
    case "1y":  return new Date(now - 365 * 86_400_000).toISOString();
    case "3y":  return new Date(now - 3 * 365 * 86_400_000).toISOString();
    case "all": return "1970-01-01T00:00:00Z";
  }
}

/** Round a Date down to the bucket boundary (start of bucket). */
function bucketKey(iso: string, bucket: PriceHistoryBucket): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  if (bucket === "weekly") {
    // Sunday-anchored week (UTC)
    const day = d.getUTCDay();
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    return start.toISOString().slice(0, 10);
  }
  if (bucket === "monthly") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  // quarterly — Q1=Jan/Q2=Apr/Q3=Jul/Q4=Oct
  const qStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  return `${d.getUTCFullYear()}-${String(qStartMonth + 1).padStart(2, "0")}-01`;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Lazy Cosmos client for the ch_daily_sales container. Constructed on
 *  demand so tests + non-daily paths don't require the env var. Set via
 *  the test seam below when mocking. */
let sharedCHContainer: Container | null = null;
function _setCHContainerForTesting(c: Container | null): void { sharedCHContainer = c; }
export { _setCHContainerForTesting };

async function getCHDailySalesContainer(): Promise<Container | null> {
  if (sharedCHContainer) return sharedCHContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
  const containerId = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
  const client = new CosmosClient(cs);
  const container = client.database(dbName).container(containerId);
  sharedCHContainer = container;
  return container;
}

/** Pull ch_daily_sales rows for a cardId with a windowed cutoff. Best-
 *  effort — returns [] on any Cosmos error so the chart still renders
 *  from sold_comps. */
async function readCHDailySalesForChart(
  cardId: string, fromDateIso: string,
): Promise<Array<{ price: number; soldAt: string; source: string; flaggedWrong?: boolean; confidence?: number }>> {
  try {
    const c = await getCHDailySalesContainer();
    if (!c) return [];
    const iter = c.items.query<{ price: unknown; sale_date: unknown }>({
      query: "SELECT c.price, c.sale_date FROM c WHERE c.card_id = @id AND c.sale_date >= @cutoff",
      parameters: [
        { name: "@id", value: cardId },
        { name: "@cutoff", value: fromDateIso },
      ],
    }, { partitionKey: cardId, maxItemCount: 1000 });
    const out: Array<{ price: number; soldAt: string; source: string }> = [];
    while (iter.hasMoreResults()) {
      const page = await iter.fetchNext();
      if (page.resources) {
        for (const row of page.resources) {
          const price = Number((row as { price: unknown }).price);
          const soldAt = String((row as { sale_date: unknown }).sale_date ?? "");
          if (!Number.isFinite(price) || price <= 0) continue;
          if (!soldAt) continue;
          out.push({ price, soldAt, source: "ch_daily_export" });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build a price time-series for a cardId. Merges the sold_comps per-query
 * pool with the ch_daily_sales bulk-ingest pool so the chart reflects the
 * FULL history. Dedups by (soldAt-day, price-cents) so the same sale
 * observed in both pools doesn't double-count. Filters to the window,
 * buckets by bucket, excludes flaggedWrong rows (moderation), excludes
 * zero/negative prices (defensive).
 */
export async function buildPriceHistory(input: {
  cardId: string;
  window?: PriceHistoryWindow;
  bucket?: PriceHistoryBucket;
  sources?: SoldCompSource[];
  minConfidence?: number;
}): Promise<PriceHistoryResult> {
  const window = input.window ?? "1y";
  const bucket = input.bucket ?? "monthly";
  const fromDate = windowStartIso(window);

  const [raw, ch] = await Promise.all([
    readCompsByCardId({ cardId: input.cardId, sources: input.sources, fromDate }),
    // Skip CH bulk pool when caller pinned a specific-sources filter —
    // they explicitly asked for user / cardsight / cardhedge and don't
    // want the bulk export mixed in.
    input.sources && input.sources.length > 0
      ? Promise.resolve([])
      : readCHDailySalesForChart(input.cardId, fromDate),
  ]);

  // Dedup by (soldAt truncated to day, priceCents). Sold_comps rows win
  // over ch_daily_sales when they collide — sold_comps carries richer
  // metadata (confidence, verifiedByUser, flaggedWrong).
  const soldCompsKey = (r: { soldAt: string; price: number }): string =>
    `${(r.soldAt || "").slice(0, 10)}::${Math.round(r.price * 100)}`;
  const seenKeys = new Set<string>();
  const filtered: Array<{ price: number; soldAt: string; source: string; confidence?: number }> = [];

  for (const r of raw) {
    if ((r as SoldCompDoc & { flaggedWrong?: boolean }).flaggedWrong === true) continue;
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    if (input.minConfidence != null && (r.confidence ?? 0) < input.minConfidence) continue;
    if (!r.soldAt) continue;
    const key = soldCompsKey(r);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    filtered.push({
      price: r.price,
      soldAt: r.soldAt,
      source: r.source,
      confidence: r.confidence,
    });
  }
  for (const r of ch) {
    const key = soldCompsKey(r);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    filtered.push(r);
  }

  // Group by bucket
  const groups = new Map<string, Array<{ price: number; soldAt: string; source: string }>>();
  for (const r of filtered) {
    const key = bucketKey(r.soldAt, bucket);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const points: PriceHistoryBucketPoint[] = Array.from(groups.entries())
    .map(([bucketStart, docs]) => {
      const prices = docs.map((d) => d.price);
      const sourceBreakdown: Record<string, number> = {};
      for (const d of docs) sourceBreakdown[d.source] = (sourceBreakdown[d.source] ?? 0) + 1;
      return {
        bucketStart,
        count: docs.length,
        medianPrice: median(prices),
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        meanPrice: prices.reduce((s, p) => s + p, 0) / prices.length,
        sourceBreakdown,
      };
    })
    .sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0));

  const sortedByDate = [...filtered].sort((a, b) =>
    a.soldAt < b.soldAt ? -1 : a.soldAt > b.soldAt ? 1 : 0,
  );
  return {
    cardId: input.cardId,
    window,
    bucket,
    totalComps: filtered.length,
    earliestSoldAt: sortedByDate[0]?.soldAt ?? null,
    latestSoldAt: sortedByDate[sortedByDate.length - 1]?.soldAt ?? null,
    points,
  };
}
