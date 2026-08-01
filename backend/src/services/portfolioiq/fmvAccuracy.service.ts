// CF-FMV-ACCURACY (Drew, 2026-08-01). Closes the loop between
// "predicted FMV" and "actual sale price". Every time a user's card
// SELLS (via user-purchase import that reveals a prior sale-price
// or a manual sale entry), we capture:
//
//   predictedFmv  — what our FMV said on the day BEFORE the sale
//   actualPrice   — what the card actually sold for
//   deltaPct      — |actual - predicted| / predicted
//
// Aggregated to give admin dashboard concrete numbers like:
//   "Our FMV was within 10% of actual sale price on 87% of 234
//    confirmed sales this month."
//
// That's the trust-in-cleanliness metric — if the clean-up work is
// paying off, this number climbs.
//
// Container: fmv_accuracy_events, partition /slug, 2yr TTL.

import { CosmosClient, type Container } from "@azure/cosmos";

export interface FmvAccuracyEvent {
  id: string;
  slug: string;              // hobbyiqCardId (partition key)
  userId: string;
  cardId: string;
  soldAt: string;
  predictedFmv: number;
  actualPrice: number;
  deltaAbs: number;
  deltaPct: number;
  withinBand: {
    within5pct: boolean;
    within10pct: boolean;
    within20pct: boolean;
    within50pct: boolean;
  };
  observedAt: string;
  ttl: number;
}

const CONTAINER_ID = process.env.COSMOS_FMV_ACCURACY_CONTAINER ?? "fmv_accuracy_events";
const TTL_SEC = 730 * 24 * 60 * 60; // 2 years

let cachedContainer: Container | null = null;

async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({ id: process.env.COSMOS_DATABASE ?? "hobbyiq" });
    const { container } = await database.containers.createIfNotExists({
      id: CONTAINER_ID,
      partitionKey: { paths: ["/slug"] },
      defaultTtl: TTL_SEC,
    });
    cachedContainer = container;
    return container;
  } catch { return null; }
}

/** Fire-and-forget capture: log an FMV-vs-actual event. */
export function logFmvAccuracy(input: {
  slug: string;
  userId: string;
  cardId: string;
  soldAt: string;
  predictedFmv: number;
  actualPrice: number;
}): void {
  void (async () => {
    try {
      const container = await getContainer();
      if (!container) return;
      if (!Number.isFinite(input.predictedFmv) || input.predictedFmv <= 0) return;
      if (!Number.isFinite(input.actualPrice) || input.actualPrice <= 0) return;
      const deltaAbs = Math.abs(input.actualPrice - input.predictedFmv);
      const deltaPct = deltaAbs / input.predictedFmv;
      const doc: FmvAccuracyEvent = {
        id: `${input.slug}::${input.userId}::${input.soldAt}::${Math.round(input.actualPrice * 100)}`,
        slug: input.slug,
        userId: input.userId,
        cardId: input.cardId,
        soldAt: input.soldAt,
        predictedFmv: input.predictedFmv,
        actualPrice: input.actualPrice,
        deltaAbs: Math.round(deltaAbs * 100) / 100,
        deltaPct: Math.round(deltaPct * 10000) / 100,
        withinBand: {
          within5pct: deltaPct <= 0.05,
          within10pct: deltaPct <= 0.10,
          within20pct: deltaPct <= 0.20,
          within50pct: deltaPct <= 0.50,
        },
        observedAt: new Date().toISOString(),
        ttl: TTL_SEC,
      };
      await container.items.upsert(doc);
    } catch { /* soft */ }
  })();
}

export interface FmvAccuracySummary {
  totalEvents: number;
  last7Days: number;
  last30Days: number;
  medianDeltaPct: number;
  meanDeltaPct: number;
  within5PctRate: number;    // 0-100 (%)
  within10PctRate: number;
  within20PctRate: number;
  within50PctRate: number;
  worstSlugs: Array<{ slug: string; sampleCount: number; medianDeltaPct: number }>;
  bestSlugs: Array<{ slug: string; sampleCount: number; medianDeltaPct: number }>;
  computedAt: string;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export async function computeFmvAccuracySummary(): Promise<FmvAccuracySummary | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = Date.now();
  const t7 = new Date(now - 7 * 86_400_000).toISOString();
  const t30 = new Date(now - 30 * 86_400_000).toISOString();

  const { resources: rows } = await container.items.query({
    query: "SELECT * FROM c"
  }, { maxItemCount: 5000 }).fetchAll();

  const events = rows as FmvAccuracyEvent[];
  if (events.length === 0) {
    return {
      totalEvents: 0, last7Days: 0, last30Days: 0,
      medianDeltaPct: 0, meanDeltaPct: 0,
      within5PctRate: 0, within10PctRate: 0, within20PctRate: 0, within50PctRate: 0,
      worstSlugs: [], bestSlugs: [],
      computedAt: new Date().toISOString(),
    };
  }

  const deltaPcts = events.map((e) => e.deltaPct);
  const mean = deltaPcts.reduce((s, x) => s + x, 0) / deltaPcts.length;
  const med = median(deltaPcts);

  const within5 = events.filter((e) => e.withinBand.within5pct).length;
  const within10 = events.filter((e) => e.withinBand.within10pct).length;
  const within20 = events.filter((e) => e.withinBand.within20pct).length;
  const within50 = events.filter((e) => e.withinBand.within50pct).length;

  // Per-slug aggregation
  const bySlug = new Map<string, number[]>();
  for (const e of events) {
    const arr = bySlug.get(e.slug) ?? [];
    arr.push(e.deltaPct);
    bySlug.set(e.slug, arr);
  }
  const slugStats: Array<{ slug: string; sampleCount: number; medianDeltaPct: number }> = [];
  for (const [slug, deltas] of bySlug) {
    if (deltas.length < 3) continue;
    slugStats.push({ slug, sampleCount: deltas.length, medianDeltaPct: Math.round(median(deltas) * 100) / 100 });
  }
  const worstSlugs = [...slugStats].sort((a, b) => b.medianDeltaPct - a.medianDeltaPct).slice(0, 10);
  const bestSlugs = [...slugStats].sort((a, b) => a.medianDeltaPct - b.medianDeltaPct).slice(0, 10);

  return {
    totalEvents: events.length,
    last7Days: events.filter((e) => e.observedAt >= t7).length,
    last30Days: events.filter((e) => e.observedAt >= t30).length,
    medianDeltaPct: Math.round(med * 100) / 100,
    meanDeltaPct: Math.round(mean * 100) / 100,
    within5PctRate: Math.round((within5 / events.length) * 10000) / 100,
    within10PctRate: Math.round((within10 / events.length) * 10000) / 100,
    within20PctRate: Math.round((within20 / events.length) * 10000) / 100,
    within50PctRate: Math.round((within50 / events.length) * 10000) / 100,
    worstSlugs, bestSlugs,
    computedAt: new Date().toISOString(),
  };
}
