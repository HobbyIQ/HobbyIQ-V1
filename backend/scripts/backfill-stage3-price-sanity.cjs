#!/usr/bin/env node
// CF-BACKFILL-STAGE3-PRICE-SANITY (Drew, 2026-08-01).
//
// Stage 3 of the pool-cleanup pipeline. Stages 1+2 canonicalized slugs;
// Stage 3 catches the OTHER contamination class — rows whose slug is
// correct but the row is the WRONG PHYSICAL CARD (e.g., a base auto sale
// mis-tagged by Cardsight's fuzzy matcher as Blue Refractor and dropped
// into the /150 Blue Refractor pool at $6 when the real market is $1,500).
//
// Only WRITES a new boolean field __priceOutlier=true on flagged rows.
// Never touches slug, parallel, price, or any existing field. Blast
// radius is one nullable boolean — trivially reversible.
//
// Algorithm per row:
//   1. Group rows by hobbyiqCardId
//   2. Compute median from CONFIRMED-SOLD sources only:
//      (cardhedge, ebay-user-purchase, manual-user-entry, ebay-user-sale,
//       ebay-browse-ended)
//   3. Only apply gate if confirmed-sold pool has >= MIN_POOL_SIZE rows
//   4. For each row in the group:
//      if price < median * FLOOR_MULT OR price > median * CEILING_MULT
//         → mark __priceOutlier=true
//
// Configurable bands (env):
//   FLOOR_MULT   default 0.2  (rows priced <20% of median are suspicious)
//   CEILING_MULT default 5.0  (rows priced >5x median are suspicious)
//   MIN_POOL_SIZE default 5   (skip pools too thin to trust median)
//   MIN_MEDIAN    default 20  (skip trivial-price pools where band %
//                              would produce false positives at the noise
//                              floor — $1 sale in a $2 pool isn't outlier)
//
//   BACKFILL_MODE / BACKFILL_APPLY   dry (default) | apply / true|false
//   BACKFILL_CONCURRENCY   default 8

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const FLOOR_MULT = Number(process.env.FLOOR_MULT || 0.2);
const CEILING_MULT = Number(process.env.CEILING_MULT || 5.0);
const MIN_POOL_SIZE = Math.max(1, Number(process.env.MIN_POOL_SIZE || 5));
const MIN_MEDIAN = Number(process.env.MIN_MEDIAN || 20);

const CONFIRMED_SOURCES = new Set([
  "cardhedge",
  "ebay-user-purchase",
  "manual-user-entry",
  "ebay-user-sale",
  "ebay-browse-ended",
]);

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[backfill-stage3-price-sanity]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  FLOOR_MULT=${FLOOR_MULT}  CEILING_MULT=${CEILING_MULT}  MIN_POOL_SIZE=${MIN_POOL_SIZE}  MIN_MEDIAN=$${MIN_MEDIAN}`);

  console.log("\nPhase 1: build per-slug medians from confirmed-sold rows...");
  const iter1 = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });

  const poolPrices = new Map(); // slug → confirmed prices only
  let scanned = 0;
  while (iter1.hasMoreResults()) {
    const { resources } = await iter1.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      if (!CONFIRMED_SOURCES.has(r.source)) continue;
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (!poolPrices.has(r.hobbyiqCardId)) poolPrices.set(r.hobbyiqCardId, []);
      poolPrices.get(r.hobbyiqCardId).push(p);
    }
    if (scanned % 500000 === 0) console.log(`  scanned=${scanned}  pools=${poolPrices.size}`);
  }

  // Compute medians
  const medianBySlug = new Map();
  let poolsSizedOk = 0, poolsSkipped = 0;
  for (const [slug, prices] of poolPrices) {
    if (prices.length < MIN_POOL_SIZE) { poolsSkipped++; continue; }
    const m = median(prices);
    if (m < MIN_MEDIAN) { poolsSkipped++; continue; }
    medianBySlug.set(slug, m);
    poolsSizedOk++;
  }
  console.log(`  confirmed-source scanned=${scanned}`);
  console.log(`  pools with >= ${MIN_POOL_SIZE} confirmed rows and median >= $${MIN_MEDIAN}: ${poolsSizedOk}`);
  console.log(`  pools skipped (too thin or trivial-price): ${poolsSkipped}`);

  console.log("\nPhase 2: scan all rows, flag outliers against pool median...");
  const iter2 = sc.items.query({
    query: `SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 500 });

  let examined = 0, flagged = 0, alreadyFlagged = 0, noPool = 0, inBand = 0, errors = 0;
  const flaggedBySource = {};
  const flaggedBands = { belowFloor: 0, aboveCeiling: 0 };
  const sampleFlags = [];
  const inFlight = [];

  while (iter2.hasMoreResults()) {
    const { resources } = await iter2.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const m = medianBySlug.get(row.hobbyiqCardId);
      if (m === undefined) { noPool++; continue; }
      const p = Number(row.price);
      if (!Number.isFinite(p) || p <= 0) continue;

      const belowFloor = p < m * FLOOR_MULT;
      const aboveCeiling = p > m * CEILING_MULT;
      if (!belowFloor && !aboveCeiling) { inBand++; continue; }

      if (row.__priceOutlier === true) { alreadyFlagged++; continue; }

      flagged++;
      flaggedBySource[row.source] = (flaggedBySource[row.source] || 0) + 1;
      if (belowFloor) flaggedBands.belowFloor++;
      if (aboveCeiling) flaggedBands.aboveCeiling++;

      if (sampleFlags.length < 12) {
        sampleFlags.push(`  $${p.toFixed(2)}  poolMedian=$${m.toFixed(0)}  ratio=${(p/m).toFixed(2)}x  [${row.source}]  ${(row.title||'').slice(0,80)}`);
      }

      if (MODE === "apply") {
        row.__priceOutlier = true;
        row.__priceOutlierAt = new Date().toISOString();
        row.__priceOutlierPoolMedian = m;
        row.__priceOutlierBand = belowFloor ? "below-floor" : "above-ceiling";
        inFlight.push(
          withRetry(() => sc.items.upsert(row))
            .catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) console.log(`  examined=${examined}  flagged=${flagged}  noPool=${noPool}  inBand=${inBand}`);
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:         ${examined}`);
  console.log(`  no pool (skip):   ${noPool}`);
  console.log(`  in band:          ${inBand}`);
  console.log(`  already flagged:  ${alreadyFlagged}`);
  console.log(`  newly flagged:    ${flagged}  (${flaggedBands.belowFloor} below floor, ${flaggedBands.aboveCeiling} above ceiling)`);
  console.log(`  errors:           ${errors}`);
  console.log(`\n  Flagged by source:`);
  Object.entries(flaggedBySource).sort((a,b) => b[1] - a[1]).forEach(([s, n]) => {
    console.log(`    ${String(n).padStart(7)}  ${s}`);
  });
  console.log(`\nSample flagged rows:`);
  sampleFlags.forEach(s => console.log(s));
}

main().catch(e => { console.error(e); process.exit(1); });
