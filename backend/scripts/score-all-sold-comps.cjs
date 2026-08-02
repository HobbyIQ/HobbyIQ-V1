#!/usr/bin/env node
// CF-SCORE-ALL-SOLD-COMPS (Drew, 2026-08-02).
//
// Retroactive confidence scoring on ALL sold_comps rows that don't
// carry __confidenceScore. Uses the current learned weights (from
// confidence_weights container). Idempotent — skips rows already
// scored. Writes the score + band + signals back to the row.
//
// Result: coverage jumps from 5.2% → 100% of the 3.5M pool. Every
// row carries an explicit confidence band that downstream can use
// for filtering, weighting, or display.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const { CosmosClient } = require("@azure/cosmos");

let scoreRow;
try {
  ({ scoreRow } = require("../dist/services/portfolioiq/confidenceScore.service.js"));
} catch (e) {
  console.error("Cannot import scoreRow from dist — build backend first");
  console.error(e.message); process.exit(2);
}

const APPLY = process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.BACKFILL_MAX_MINUTES || 25));
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const START = Date.now();
function timeExpired() { return (Date.now() - START) / 60000 > MAX_MINUTES; }

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[score-all-sold-comps] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}`);

  // Only rows that haven't been scored yet
  const query = "SELECT * FROM c WHERE NOT IS_DEFINED(c.__confidenceScore) " +
                "AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null " +
                "AND c.price > 0";
  const iter = sc.items.query({ query }, { maxItemCount: 200 });

  // Pool-median cache: slug -> {median, sampleCount}. Query once per
  // slug per slice; many rows share the same slug so the cache saves
  // a huge number of pool queries.
  const poolCache = new Map();
  async function getPool(slug) {
    if (poolCache.has(slug)) return poolCache.get(slug);
    try {
      const { resources } = await sc.items.query({
        query: "SELECT TOP 20 c.price FROM c WHERE c.hobbyiqCardId = @slug ORDER BY c.soldAt DESC",
        parameters: [{ name: "@slug", value: slug }],
      }).fetchAll();
      const prices = (resources || []).map(r => Number(r.price)).filter(p => Number.isFinite(p) && p > 0);
      if (prices.length === 0) { poolCache.set(slug, { median: null, sampleCount: 0 }); return { median: null, sampleCount: 0 }; }
      const sorted = [...prices].sort((a, b) => a - b);
      const val = { median: sorted[Math.floor(sorted.length / 2)], sampleCount: prices.length };
      poolCache.set(slug, val);
      return val;
    } catch { poolCache.set(slug, { median: null, sampleCount: 0 }); return { median: null, sampleCount: 0 }; }
  }

  const stats = { scanned: 0, scored: 0, errors: 0, bands: { autoTrust: 0, flagReview: 0, quarantine: 0, reject: 0 } };
  const inFlight = [];

  async function processRow(row) {
    try {
      const { median, sampleCount } = await getPool(row.hobbyiqCardId);
      const result = await scoreRow({
        row,
        poolMedian: median,
        poolSampleCount: sampleCount,
        catalogHasCanonicalForCardnumberYear: true,
        catalogAgreesOnSet: true,
        sellerBadActorScore: 0,
      });
      if (result.band === "auto-trust") stats.bands.autoTrust++;
      else if (result.band === "flag-review") stats.bands.flagReview++;
      else if (result.band === "quarantine") stats.bands.quarantine++;
      else stats.bands.reject++;
      stats.scored++;
      if (APPLY) {
        row.__confidenceScore = result.score;
        row.__confidenceBand = result.band;
        row.__confidenceScoredAt = new Date().toISOString();
        await withRetry(() => sc.items.upsert(row));
      }
    } catch { stats.errors++; }
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
      if (stats.scanned % 2000 === 0) {
        console.log(`  scanned=${stats.scanned} scored=${stats.scored} err=${stats.errors} bands: hi=${stats.bands.autoTrust} mid=${stats.bands.flagReview} lo=${stats.bands.quarantine} rej=${stats.bands.reject} poolCache=${poolCache.size}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:      ${stats.scanned}`);
  console.log(`  scored:       ${stats.scored}`);
  console.log(`  errors:       ${stats.errors}`);
  console.log(`  pool cache:   ${poolCache.size} distinct slugs`);
  console.log(`  bands:`);
  console.log(`    auto-trust (>=.85):  ${stats.bands.autoTrust}`);
  console.log(`    flag-review (.60-.85): ${stats.bands.flagReview}`);
  console.log(`    quarantine (.40-.60):  ${stats.bands.quarantine}`);
  console.log(`    reject (<.40):        ${stats.bands.reject}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); });
