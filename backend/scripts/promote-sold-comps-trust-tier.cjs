#!/usr/bin/env node
// CF-TRUST-TIER-PROMOTION (Drew, 2026-08-01).
//
// Every sold_comps row starts as verifyStatus="unverified" (via
// ingest write path — TODO to be added). This periodic job promotes
// rows to "confirmed" when they've cleared the trust bar:
//   - Age >= 7 days (fresh sales less trusted — could be re-listed)
//   - Not flagged with any of __priceOutlier / __cardsightUnverified
//     / __userFlagQuarantine / __badActorSeller
//   - Confirmed source (cardhedge / ebay-user-purchase / manual-user-entry
//     / ebay-user-sale / ebay-browse-ended)
//   - Price within 3x-0.3x of pool median (broader than the outlier
//     flag but tighter than random)
//
// Rows failing any check STAY at their current status (unverified) —
// they can still show in views that opt in, but the "trusted pool"
// filter (verifyStatus="confirmed") gets the cleanest snapshot.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   BACKFILL_CONCURRENCY       default 8

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));
const AGE_DAYS = 7;
const CONFIRMED_SOURCES = new Set([
  "cardhedge", "ebay-user-purchase", "manual-user-entry", "ebay-user-sale", "ebay-browse-ended",
]);
const NARROW_FLOOR = 0.3;
const NARROW_CEIL = 3.0;
const MIN_POOL_FOR_MEDIAN = 5;

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[promote-trust-tier]  mode=${MODE}  concurrency=${CONCURRENCY}`);

  // Phase 1: build per-slug medians (confirmed sources only)
  console.log("\nPhase 1: build per-slug medians...");
  const iter1 = sc.items.query({
    query: `SELECT c.hobbyiqCardId, c.price, c.source FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:') AND IS_DEFINED(c.price)`
  }, { maxItemCount: 5000 });
  const pool = new Map();
  let scanned = 0;
  while (iter1.hasMoreResults()) {
    const { resources } = await iter1.fetchNext();
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
  const medians = new Map();
  for (const [slug, prices] of pool) {
    if (prices.length < MIN_POOL_FOR_MEDIAN) continue;
    medians.set(slug, median(prices));
  }
  console.log(`  confirmed rows scanned: ${scanned}`);
  console.log(`  pools with medians:     ${medians.size}`);

  // Phase 2: iterate all rows, decide promotion
  console.log("\nPhase 2: promote qualifying rows to verifyStatus='confirmed'...");
  const iter2 = sc.items.query({
    query: `SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')
              AND (NOT IS_DEFINED(c.verifyStatus) OR c.verifyStatus != 'confirmed')`
  }, { maxItemCount: 500 });

  const cutoffDate = new Date(Date.now() - AGE_DAYS * 86_400_000).toISOString();
  let examined = 0, promoted = 0, tooYoung = 0, flagged = 0, badSource = 0, noPool = 0, priceOff = 0, errors = 0;
  const inFlight = [];

  while (iter2.hasMoreResults()) {
    const { resources } = await iter2.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      // Filter 1: age
      const at = row.soldAt || row.observedAt;
      if (!at || at > cutoffDate) { tooYoung++; continue; }
      // Filter 2: source
      if (!CONFIRMED_SOURCES.has(row.source)) { badSource++; continue; }
      // Filter 3: no contamination flags
      if (row.__priceOutlier === true || row.__cardsightUnverified === true
        || row.__userFlagQuarantine === true || row.__badActorSeller === true) { flagged++; continue; }
      // Filter 4: price within pool band
      const m = medians.get(row.hobbyiqCardId);
      if (m === undefined) { noPool++; continue; }
      const p = Number(row.price);
      if (!Number.isFinite(p) || p <= 0) { priceOff++; continue; }
      if (p < m * NARROW_FLOOR || p > m * NARROW_CEIL) { priceOff++; continue; }

      // Promote
      promoted++;
      if (MODE === "apply") {
        row.verifyStatus = "confirmed";
        row.verifyStatusAt = new Date().toISOString();
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).catch(() => { errors++; })
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
    if (examined % 100000 === 0) {
      console.log(`  examined=${examined}  promoted=${promoted}  flagged=${flagged}  noPool=${noPool}  tooYoung=${tooYoung}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:  ${examined}`);
  console.log(`  promoted:  ${promoted}`);
  console.log(`  filtered by:`);
  console.log(`    too young (< ${AGE_DAYS}d):  ${tooYoung}`);
  console.log(`    non-confirmed source:  ${badSource}`);
  console.log(`    has contamination flag:${flagged}`);
  console.log(`    no pool median:         ${noPool}`);
  console.log(`    price out of narrow band:${priceOff}`);
  console.log(`  errors:    ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
