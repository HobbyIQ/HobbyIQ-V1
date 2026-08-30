// CF-ANOMALY-DETECTION (Drew, 2026-08-01). Cron-friendly detector
// that compares CURRENT pool state to the most recent baseline
// snapshot and surfaces slugs whose median moved suspiciously.
//
// "Suspiciously" = median shifted ≥ 30% without corresponding
// sample-size growth (i.e., a few outlier rows dragged the median).
// That's the fingerprint of contamination sneaking in.
//
// Runs on-demand via admin endpoint AND nightly via cron (chained
// after baseline-snapshot in nightly-cleanliness.yml).

import { CosmosClient, type Container } from "@azure/cosmos";

export interface AnomalyRow {
  slug: string;
  baselineMedian: number;
  currentMedian: number;
  driftPct: number;
  driftDirection: "up" | "down";
  baselineSample: number;
  currentSample: number;
  sampleGrowthPct: number;
  suspiciousness: "high" | "medium" | "low";
}

export interface AnomalyReport {
  baselineDate: string;
  slugsWithBaseline: number;
  slugsChanged: number;
  anomalies: AnomalyRow[];
  computedAt: string;
}

const DRIFT_THRESHOLD = 0.30;
const MIN_BASELINE_SAMPLES = 5;
const HIGH_SUSPICIOUS_THRESHOLD = 0.50;   // >=50% median move + <20% sample growth = high
const CONFIRMED_SOURCES = new Set([
  "cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-account", "ebay-browse-ended",
]);

let cachedSc: Container | null = null;
let cachedBaseline: Container | null = null;

// CF-ANOMALY-REPORT-CACHE (Drew, 2026-08-02). Full sold_comps scan
// is expensive (3.5M rows, ~30s under load). Cache the report for
// 5 minutes in-process so admin dashboard refreshes are instant.
// Nightly cron passes { force: true } to bypass. Consumer-side
// staleness of 5min is fine — anomaly detection is a health signal,
// not a live indicator.
const ANOMALY_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedAnomalyReport: { at: number; report: AnomalyReport } | null = null;

function getSc(): Container | null {
  if (cachedSc) return cachedSc;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  cachedSc = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  return cachedSc;
}

async function getBaselineContainer(): Promise<Container | null> {
  if (cachedBaseline) return cachedBaseline;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  try {
    const { container } = await db.containers.createIfNotExists({
      id: process.env.COSMOS_BASELINE_CONTAINER ?? "pool_baseline_snapshots",
      partitionKey: { paths: ["/snapshotDate"] },
      defaultTtl: -1,
    });
    cachedBaseline = container;
    return container;
  } catch { return null; }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export async function detectAnomalies(opts: { force?: boolean } = {}): Promise<AnomalyReport | null> {
  const now = Date.now();
  if (!opts.force && cachedAnomalyReport && (now - cachedAnomalyReport.at) < ANOMALY_CACHE_TTL_MS) {
    return cachedAnomalyReport.report;
  }
  const sc = getSc();
  const baseline = await getBaselineContainer();
  if (!sc || !baseline) return null;

  // Find most recent baseline snapshot date
  const { resources: dateRes } = await baseline.items.query({
    query: "SELECT VALUE MAX(c.snapshotDate) FROM c"
  }).fetchAll();
  const latestDate = dateRes[0] as string | undefined;
  if (!latestDate) return null;

  // Load baseline rows for that date
  const { resources: baselineRows } = await baseline.items.query({
    query: "SELECT * FROM c WHERE c.snapshotDate = @d",
    parameters: [{ name: "@d", value: latestDate }],
  }, { partitionKey: latestDate }).fetchAll();
  const baselineMap = new Map<string, { median: number; sampleCount: number }>();
  for (const r of baselineRows) {
    baselineMap.set(String((r as { slug: string }).slug), {
      median: Number((r as { median: number }).median),
      sampleCount: Number((r as { sampleCount: number }).sampleCount),
    });
  }

  // Compute current medians for slugs that have baseline
  const currentByslug = new Map<string, number[]>();
  const iter = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      const slug = String((r as { hobbyiqCardId: string }).hobbyiqCardId);
      if (!baselineMap.has(slug)) continue;
      if (!CONFIRMED_SOURCES.has(String((r as { source: string }).source))) continue;
      const p = Number((r as { price: number }).price);
      if (!Number.isFinite(p) || p <= 0) continue;
      const arr = currentByslug.get(slug) ?? [];
      arr.push(p);
      currentByslug.set(slug, arr);
    }
  }

  const anomalies: AnomalyRow[] = [];
  for (const [slug, base] of baselineMap) {
    if (base.sampleCount < MIN_BASELINE_SAMPLES) continue;
    const current = currentByslug.get(slug);
    if (!current || current.length === 0) continue;
    const curMedian = median(current);
    const drift = Math.abs(curMedian - base.median) / base.median;
    if (drift < DRIFT_THRESHOLD) continue;

    const sampleGrowth = (current.length - base.sampleCount) / Math.max(base.sampleCount, 1);
    // Suspiciousness heuristic: big drift + small sample growth = likely contamination.
    // Big drift + big sample growth = maybe legit market move (many new sales at new price).
    const suspiciousness: AnomalyRow["suspiciousness"] =
      drift >= HIGH_SUSPICIOUS_THRESHOLD && sampleGrowth < 0.20 ? "high"
      : drift >= DRIFT_THRESHOLD && sampleGrowth < 0.50 ? "medium"
      : "low";
    anomalies.push({
      slug,
      baselineMedian: base.median,
      currentMedian: curMedian,
      driftPct: Math.round(drift * 10000) / 100,
      driftDirection: curMedian > base.median ? "up" : "down",
      baselineSample: base.sampleCount,
      currentSample: current.length,
      sampleGrowthPct: Math.round(sampleGrowth * 10000) / 100,
      suspiciousness,
    });
  }
  anomalies.sort((a, b) => b.driftPct - a.driftPct);

  const report: AnomalyReport = {
    baselineDate: latestDate,
    slugsWithBaseline: baselineMap.size,
    slugsChanged: anomalies.length,
    anomalies,
    computedAt: new Date().toISOString(),
  };
  cachedAnomalyReport = { at: Date.now(), report };
  return report;
}
