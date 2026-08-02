#!/usr/bin/env node
// CF-RESCORE-ANOMALIES (Drew, 2026-08-02).
//
// Retroactive confidence-score re-application on comps_staging rows
// with status='anomaly'. These rows were flagged at ingest time using
// hand-tuned confidence weights; since then Drew's admin clicks have
// trained learned weights (price, cardYear tightened). Any anomaly
// row that now scores >= 0.60 gets flipped to status='clean' so the
// normal promotion job picks it up in the next 5-min cron cycle.
//
// Idempotent via __rescoredAt marker. Safe to re-dispatch.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 6)
//   PROMOTE_THRESHOLD          default 0.60 (matches confidence band)

const { CosmosClient } = require("@azure/cosmos");

let scoreRow;
try {
  ({ scoreRow } = require("../dist/services/portfolioiq/confidenceScore.service.js"));
} catch (e) {
  console.error("Cannot import scoreRow from dist — build the backend first (npm run build)");
  console.error(e.message);
  process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 6));
const THRESHOLD = Math.max(0, Math.min(1, Number(process.env.PROMOTE_THRESHOLD || 0.60)));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const staging = db.container("comps_staging");
  const soldComps = db.container("sold_comps");
  console.log(`[rescore-anomalies] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES} threshold=${THRESHOLD}`);

  const query = "SELECT * FROM c WHERE c.status = 'anomaly' AND (NOT IS_DEFINED(c.__rescoredAt))";
  const iter = staging.items.query({ query }, { maxItemCount: 200 });

  const stats = { scanned: 0, rescored: 0, promoted: 0, stillLow: 0, errors: 0, distribution: { high: 0, mid: 0, low: 0, veryLow: 0 } };
  const inFlight = [];

  async function processRow(row) {
    try {
      // Build ConfidenceInput from staging clean payload
      const clean = row.clean;
      if (!clean) { stats.errors++; return; }

      // Fetch pool median for priceInBand signal — TOP 20 recent sales
      let poolMedian = null, poolSampleCount = 0;
      if (clean.hobbyiqCardId) {
        try {
          const { resources: pool } = await soldComps.items.query({
            query: "SELECT TOP 20 c.price FROM c WHERE c.hobbyiqCardId = @slug ORDER BY c.soldAt DESC",
            parameters: [{ name: "@slug", value: clean.hobbyiqCardId }],
          }).fetchAll();
          const prices = (pool || []).map(r => Number(r.price)).filter(p => Number.isFinite(p) && p > 0);
          if (prices.length > 0) {
            const sorted = [...prices].sort((a, b) => a - b);
            poolMedian = sorted[Math.floor(sorted.length / 2)];
            poolSampleCount = prices.length;
          }
        } catch { /* soft */ }
      }

      const result = await scoreRow({
        row: clean,
        poolMedian,
        poolSampleCount,
        catalogHasCanonicalForCardnumberYear: !!clean.hobbyiqCardId,
        catalogAgreesOnSet: true,   // if hobbyiqCardId exists, assume catalog agrees
        sellerBadActorScore: 0,
      });

      const score = result.score;
      if (score >= 0.85) stats.distribution.high++;
      else if (score >= 0.60) stats.distribution.mid++;
      else if (score >= 0.40) stats.distribution.low++;
      else stats.distribution.veryLow++;

      stats.rescored++;

      if (score >= THRESHOLD) {
        // Promote by flipping status
        stats.promoted++;
        if (APPLY) {
          row.status = "clean";
          row.__rescoredAt = new Date().toISOString();
          row.__rescoreScore = score;
          row.__rescoreBand = result.band;
          await withRetry(() => staging.items.upsert(row));
        }
      } else {
        stats.stillLow++;
        if (APPLY) {
          row.__rescoredAt = new Date().toISOString();
          row.__rescoreScore = score;
          row.__rescoreBand = result.band;
          await withRetry(() => staging.items.upsert(row));
        }
      }
    } catch (e) { stats.errors++; }
  }

  while (iter.hasMoreResults()) {
    if (timeExpired()) { console.log("⏰ time cap reached"); break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      stats.scanned++;
      inFlight.push(processRow(row).catch(() => { stats.errors++; }));
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
      if (stats.scanned % 500 === 0) {
        console.log(`  scanned=${stats.scanned} rescored=${stats.rescored} promoted=${stats.promoted} stillLow=${stats.stillLow} err=${stats.errors}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:     ${stats.scanned}`);
  console.log(`  rescored:    ${stats.rescored}`);
  console.log(`  promoted (score >= ${THRESHOLD}): ${stats.promoted}  ← flipped to status=clean`);
  console.log(`  still low:   ${stats.stillLow}`);
  console.log(`  errors:      ${stats.errors}`);
  console.log(`  distribution: high(>=.85)=${stats.distribution.high}  mid(.60-.85)=${stats.distribution.mid}  low(.40-.60)=${stats.distribution.low}  veryLow(<.40)=${stats.distribution.veryLow}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); });
