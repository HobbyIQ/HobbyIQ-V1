#!/usr/bin/env node
// CF-BASELINE-POOL-SNAPSHOT (Drew, 2026-08-01).
//
// Freezes per-slug pool state to a `pool_baseline_snapshots` container.
// Each snapshot row records: slug, sampleCount, median, p10, p90,
// snapshotAt.
//
// Drift monitor (--mode=drift) compares CURRENT pool state to the
// latest baseline and flags any slug whose median has shifted >20%
// without a corresponding change in sample size — that's a signature
// of pool contamination sneaking in.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BASELINE_MODE              snapshot | drift  (default snapshot)
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BASELINE_DRIFT_THRESHOLD   default 0.20  (20% median shift = alert)
//   BASELINE_MIN_SAMPLES       default 5

const { CosmosClient } = require("@azure/cosmos");

const OP_MODE = (process.env.BASELINE_MODE || "snapshot").toLowerCase();
const APPLY = process.env.BACKFILL_APPLY === "true" || (process.env.BACKFILL_MODE || "dry").toLowerCase() === "apply";
const DRIFT_THRESHOLD = Number(process.env.BASELINE_DRIFT_THRESHOLD || 0.20);
const MIN_SAMPLES = Math.max(1, Number(process.env.BASELINE_MIN_SAMPLES || 5));

const CONFIRMED_SOURCES = new Set([
  "cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-browse-ended",
]);
const CONTAINER_ID = process.env.COSMOS_BASELINE_CONTAINER || "pool_baseline_snapshots";

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function percentile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.min(sortedNums.length - 1, Math.floor(sortedNums.length * p));
  return sortedNums[idx];
}

async function ensureBaselineContainer(db) {
  try {
    const { container } = await db.containers.createIfNotExists({
      id: CONTAINER_ID,
      partitionKey: { paths: ["/snapshotDate"] },
      defaultTtl: -1,
    });
    return container;
  } catch (e) {
    console.error("ERR ensuring baseline container:", e.message);
    throw e;
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");
  const baseline = await ensureBaselineContainer(db);
  const snapshotDate = new Date().toISOString().slice(0, 10);

  console.log(`[baseline-pool-snapshot]  op=${OP_MODE}  apply=${APPLY}`);

  // Phase 1: compute current pool medians
  console.log("\nComputing current pool medians (confirmed sources only)...");
  const iter = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });
  const pool = new Map();
  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      if (!CONFIRMED_SOURCES.has(r.source)) continue;
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (!pool.has(r.hobbyiqCardId)) pool.set(r.hobbyiqCardId, []);
      pool.get(r.hobbyiqCardId).push(p);
    }
  }
  console.log(`  scanned: ${scanned}  slugs: ${pool.size}`);

  const currentStats = new Map();
  for (const [slug, prices] of pool) {
    if (prices.length < MIN_SAMPLES) continue;
    const sorted = [...prices].sort((a, b) => a - b);
    currentStats.set(slug, {
      sampleCount: prices.length,
      median: median(prices),
      p10: percentile(sorted, 0.10),
      p90: percentile(sorted, 0.90),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    });
  }
  console.log(`  slugs with >= ${MIN_SAMPLES} confirmed samples: ${currentStats.size}`);

  if (OP_MODE === "snapshot") {
    if (!APPLY) {
      console.log(`\nDRY: would write ${currentStats.size} baseline rows.`);
      return;
    }
    console.log(`\nWriting baseline snapshot for ${snapshotDate}...`);
    let written = 0;
    for (const [slug, stats] of currentStats) {
      const doc = {
        id: `${snapshotDate}::${slug.replace(/[^a-z0-9]/g, "-").slice(0, 200)}`,
        snapshotDate,
        slug,
        ...stats,
        capturedAt: new Date().toISOString(),
      };
      try { await baseline.items.upsert(doc); written++; } catch { /* skip */ }
      if (written % 1000 === 0) console.log(`  written=${written}`);
    }
    console.log(`\nBaseline snapshot complete: ${written} slugs recorded for ${snapshotDate}`);
  } else if (OP_MODE === "drift") {
    console.log(`\nDrift check: comparing current vs most recent baseline...`);
    // Load latest baseline snapshot (most recent snapshotDate)
    const latestDateQ = await baseline.items.query({
      query: "SELECT VALUE MAX(c.snapshotDate) FROM c"
    }).fetchAll();
    const latestDate = latestDateQ.resources[0];
    if (!latestDate) { console.log("  no baseline found — run --mode=snapshot first"); return; }
    console.log(`  latest baseline date: ${latestDate}`);
    const { resources: baseRows } = await baseline.items.query({
      query: "SELECT * FROM c WHERE c.snapshotDate = @d",
      parameters: [{ name: "@d", value: latestDate }],
    }, { partitionKey: latestDate }).fetchAll();
    const baselineMap = new Map(baseRows.map((r) => [r.slug, r]));
    console.log(`  baseline rows loaded: ${baselineMap.size}`);

    const drifted = [];
    for (const [slug, current] of currentStats) {
      const base = baselineMap.get(slug);
      if (!base) continue;
      const baseMedian = Number(base.median);
      const drift = Math.abs(current.median - baseMedian) / baseMedian;
      if (drift >= DRIFT_THRESHOLD) {
        drifted.push({
          slug,
          baselineMedian: baseMedian,
          currentMedian: current.median,
          driftPct: Math.round(drift * 10000) / 100,
          baselineSample: base.sampleCount,
          currentSample: current.sampleCount,
        });
      }
    }
    drifted.sort((a, b) => b.driftPct - a.driftPct);
    console.log(`\nSlugs with drift >= ${DRIFT_THRESHOLD * 100}%: ${drifted.length}`);
    console.log(`\nTop 30 largest drifts:`);
    drifted.slice(0, 30).forEach((d) => {
      const dir = d.currentMedian > d.baselineMedian ? "↑" : "↓";
      console.log(`  ${dir}${d.driftPct}%  $${d.baselineMedian.toFixed(0)} → $${d.currentMedian.toFixed(0)}  n=${d.baselineSample}→${d.currentSample}  ${d.slug}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
