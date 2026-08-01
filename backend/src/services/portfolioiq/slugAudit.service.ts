// CF-SLUG-AUDIT (Drew, 2026-08-01). Per-slug pool health report.
// Aggregates sold_comps by hobbyiqCardId and computes: sample count,
// median, min/max, contamination % (flagged rows / total), top
// contributing sources, most-recent activity.
//
// Backs the /app/admin/slug-audit page — lets Drew see which pools
// need attention instead of scrolling raw sold_comps rows.
//
// Cached 15 min (expensive full-container aggregation).

import { CosmosClient, type Container } from "@azure/cosmos";

export interface SlugAuditRow {
  slug: string;
  sampleCount: number;
  median: number;
  min: number;
  max: number;
  contaminationPct: number;
  flaggedCount: number;
  bySource: Record<string, number>;
  lastActivityAt: string | null;
}

export interface SlugAuditReport {
  totalSlugs: number;
  topByVolume: SlugAuditRow[];
  topByContamination: SlugAuditRow[];
  computedAt: string;
  minSampleFilter: number;
}

const MIN_SAMPLES = 3;
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { report: SlugAuditReport; at: number } | null = null;

let cachedSc: Container | null = null;
function getSc(): Container | null {
  if (cachedSc) return cachedSc;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedSc = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  return cachedSc;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export async function computeSlugAuditReport(force = false): Promise<SlugAuditReport | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report;
  const sc = getSc();
  if (!sc) return null;

  const agg = new Map<string, {
    prices: number[];
    bySource: Record<string, number>;
    flagged: number;
    lastAt: string | null;
  }>();

  const iter = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source, c.__priceOutlier, c.__cardsightUnverified,
                   c.__userFlagQuarantine, c.__badActorSeller, c.soldAt, c.observedAt
              FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      const slug = String((r as { hobbyiqCardId: string }).hobbyiqCardId);
      const price = Number((r as { price: number }).price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const src = String((r as { source: string }).source ?? "unknown");
      const dt = ((r as { soldAt?: string }).soldAt ?? (r as { observedAt?: string }).observedAt) ?? null;

      let entry = agg.get(slug);
      if (!entry) {
        entry = { prices: [], bySource: {}, flagged: 0, lastAt: null };
        agg.set(slug, entry);
      }
      entry.prices.push(price);
      entry.bySource[src] = (entry.bySource[src] ?? 0) + 1;
      if ((r as { __priceOutlier?: boolean }).__priceOutlier === true) entry.flagged++;
      else if ((r as { __cardsightUnverified?: boolean }).__cardsightUnverified === true) entry.flagged++;
      else if ((r as { __userFlagQuarantine?: boolean }).__userFlagQuarantine === true) entry.flagged++;
      else if ((r as { __badActorSeller?: boolean }).__badActorSeller === true) entry.flagged++;
      if (dt && (!entry.lastAt || dt > entry.lastAt)) entry.lastAt = dt;
    }
  }

  const rows: SlugAuditRow[] = [];
  for (const [slug, e] of agg) {
    if (e.prices.length < MIN_SAMPLES) continue;
    const sortedPrices = [...e.prices].sort((a, b) => a - b);
    rows.push({
      slug,
      sampleCount: e.prices.length,
      median: median(e.prices),
      min: sortedPrices[0],
      max: sortedPrices[sortedPrices.length - 1],
      contaminationPct: Math.round((e.flagged / e.prices.length) * 10000) / 100,
      flaggedCount: e.flagged,
      bySource: e.bySource,
      lastActivityAt: e.lastAt,
    });
  }

  const report: SlugAuditReport = {
    totalSlugs: agg.size,
    topByVolume: [...rows].sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 100),
    topByContamination: [...rows]
      .filter((r) => r.sampleCount >= 10 && r.contaminationPct >= 25)
      .sort((a, b) => b.contaminationPct - a.contaminationPct)
      .slice(0, 100),
    computedAt: new Date().toISOString(),
    minSampleFilter: MIN_SAMPLES,
  };
  cache = { report, at: Date.now() };
  return report;
}
