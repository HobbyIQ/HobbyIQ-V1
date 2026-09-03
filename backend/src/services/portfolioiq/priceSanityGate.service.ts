// CF-PRICE-SANITY-GATE (Drew, 2026-08-01). Ingest-time equivalent of
// the Stage 3 backfill. Before we write a new sold_comps row, look up
// the target pool's median (cached in memory with 15-min TTL). If the
// incoming price is wildly off, mark __priceOutlier=true at write.
// Prevents new pool contamination BEFORE it hits the container.
//
// Cache: {slug → {median, computedAt}}. Median computed from CONFIRMED-
// SOLD sources only (excludes cardsight — same rule as Stage 3).
// Cache miss triggers a bounded query; hits/misses tracked via
// telemetry.
//
// Zero-cost path: if the pool has < MIN_POOL_SIZE confirmed rows or
// median < MIN_MEDIAN, we don't flag (not enough signal). Returns
// false quickly.

import type { Container } from "@azure/cosmos";

const CACHE = new Map<string, { median: number; computedAt: number; sampleCount: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MIN_POOL_SIZE = 5;
const MIN_MEDIAN = 20;
const FLOOR_MULT = 0.2;
const CEILING_MULT = 5.0;
// POOL-1 residue (audit, 2026-09-03). This gate decides whether an INCOMING
// price is an outlier by comparing it to the slug's own median. An
// adjudicated-wrong row left in that reference pool moves the median, and so
// moves the floor/ceiling the gate admits new rows by -- a bad row defending
// the next bad row. Same store-form predicate as exactPoolReader:84-85.
const ADJUDICATION_FILTER =
  "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)"
  + " AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)";

const CONFIRMED_SOURCES = ["cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-account", "ebay-browse-ended"];

interface SanityResult {
  isOutlier: boolean;
  band?: "below-floor" | "above-ceiling";
  poolMedian?: number;
  poolSampleCount?: number;
  reason: string;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function computeMedianForSlug(container: Container, slug: string): Promise<{ median: number | null; sampleCount: number }> {
  try {
    const params = CONFIRMED_SOURCES.map((_, i) => ({ name: `@s${i}`, value: CONFIRMED_SOURCES[i] }));
    const sourceList = CONFIRMED_SOURCES.map((_, i) => `@s${i}`).join(",");
    const { resources } = await container.items.query({
      query: `SELECT c.price FROM c WHERE c.hobbyiqCardId = @slug AND c.source IN (${sourceList}) AND IS_DEFINED(c.price) AND ${ADJUDICATION_FILTER}`,
      parameters: [{ name: "@slug", value: slug }, ...params],
    }, { maxItemCount: 500 }).fetchAll();
    const prices = (resources ?? [])
      .map((r) => Number((r as { price: number }).price))
      .filter((p) => Number.isFinite(p) && p > 0);
    if (prices.length < MIN_POOL_SIZE) return { median: null, sampleCount: prices.length };
    const m = median(prices);
    return { median: m, sampleCount: prices.length };
  } catch {
    return { median: null, sampleCount: 0 };
  }
}

export async function checkPriceSanity(
  container: Container,
  slug: string | null | undefined,
  incomingPrice: number,
): Promise<SanityResult> {
  if (!slug || typeof slug !== "string" || !slug.startsWith("hiq:")) {
    return { isOutlier: false, reason: "no slug — skip" };
  }
  if (!Number.isFinite(incomingPrice) || incomingPrice <= 0) {
    return { isOutlier: false, reason: "invalid price — skip" };
  }

  const now = Date.now();
  let cached = CACHE.get(slug);
  if (!cached || now - cached.computedAt > CACHE_TTL_MS) {
    const { median: m, sampleCount } = await computeMedianForSlug(container, slug);
    if (m === null) {
      CACHE.set(slug, { median: -1, computedAt: now, sampleCount });
      return { isOutlier: false, reason: `pool too thin (n=${sampleCount})` };
    }
    cached = { median: m, computedAt: now, sampleCount };
    CACHE.set(slug, cached);
  }

  if (cached.median <= 0) return { isOutlier: false, reason: "cached-thin-pool" };
  if (cached.median < MIN_MEDIAN) return { isOutlier: false, reason: "median too low — skip" };

  const belowFloor = incomingPrice < cached.median * FLOOR_MULT;
  const aboveCeiling = incomingPrice > cached.median * CEILING_MULT;

  if (belowFloor) return {
    isOutlier: true, band: "below-floor",
    poolMedian: cached.median, poolSampleCount: cached.sampleCount,
    reason: `price $${incomingPrice} < ${FLOOR_MULT}x poolMedian $${cached.median.toFixed(0)}`,
  };
  if (aboveCeiling) return {
    isOutlier: true, band: "above-ceiling",
    poolMedian: cached.median, poolSampleCount: cached.sampleCount,
    reason: `price $${incomingPrice} > ${CEILING_MULT}x poolMedian $${cached.median.toFixed(0)}`,
  };
  return { isOutlier: false, reason: "in-band" };
}

export function invalidatePriceSanityCache(slug: string): void {
  CACHE.delete(slug);
}
