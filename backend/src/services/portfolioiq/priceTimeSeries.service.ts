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

import { readCompsByCardId, type SoldCompDoc, type SoldCompSource } from "./soldCompsStore.service.js";

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

/**
 * Build a price time-series for a cardId from sold_comps. Filters to the
 * window, buckets by bucket, excludes flaggedWrong rows (moderation),
 * excludes zero/negative prices (defensive).
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

  const raw = await readCompsByCardId({
    cardId: input.cardId,
    sources: input.sources,
    fromDate,
  });

  const filtered = raw.filter((r) => {
    if ((r as SoldCompDoc & { flaggedWrong?: boolean }).flaggedWrong === true) return false;
    if (!Number.isFinite(r.price) || r.price <= 0) return false;
    if (input.minConfidence != null && (r.confidence ?? 0) < input.minConfidence) return false;
    if (!r.soldAt) return false;
    return true;
  });

  // Group by bucket
  const groups = new Map<string, SoldCompDoc[]>();
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
