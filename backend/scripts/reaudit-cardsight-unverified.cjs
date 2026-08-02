#!/usr/bin/env node
// CF-REAUDIT-CS-UNVERIFIED (Drew, 2026-08-02).
//
// The 529K rows carrying __cardsightUnverified were flagged when the
// CS pipeline was less trusted (before cross-source consensus, learned
// weights, and image probes were in place). This job re-evaluates
// each and clears the flag when current signals now support the row.
//
// A row's __cardsightUnverified flag CLEARS if ANY of:
//   1. Same slug has >= 3 non-CS sales in a ±30% price band around
//      this row's price (peer confirmation)
//   2. Row already carries __consensusVerified = true (cross-source
//      already agreed)
//   3. Row's __confidenceScore >= 0.60 (learned scorer trusts it)
//
// Otherwise flag stays.
//
// Idempotent via __cardsightReauditedAt marker.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   BACKFILL_MAX_MINUTES       per-slice cap (default 25)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const { CosmosClient } = require("@azure/cosmos");

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
  console.log(`[reaudit-cardsight-unverified] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}`);

  const query = "SELECT * FROM c WHERE c.__cardsightUnverified = true " +
                "AND (NOT IS_DEFINED(c.__cardsightReauditedAt))";
  const iter = sc.items.query({ query }, { maxItemCount: 200 });

  // Cache non-CS peer counts per (slug, priceBand)
  const peerCache = new Map();
  async function nonCsPeersAgree(slug, price) {
    if (!slug || !Number.isFinite(price) || price <= 0) return 0;
    const bandLow = price * 0.7;
    const bandHigh = price * 1.3;
    const key = `${slug}|${Math.round(price/10)*10}`;   // 10-dollar buckets
    if (peerCache.has(key)) return peerCache.get(key);
    try {
      const { resources } = await sc.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @slug " +
               "AND c.source != 'cardsight' AND c.price >= @lo AND c.price <= @hi",
        parameters: [{ name: "@slug", value: slug }, { name: "@lo", value: bandLow }, { name: "@hi", value: bandHigh }],
      }).fetchAll();
      const n = Number(resources[0]) || 0;
      peerCache.set(key, n);
      return n;
    } catch { peerCache.set(key, 0); return 0; }
  }

  const stats = { scanned: 0, cleared: 0, keptFlagged: 0, errors: 0, reasons: { peers: 0, consensus: 0, score: 0 } };
  const inFlight = [];

  async function processRow(row) {
    try {
      const nowIso = new Date().toISOString();
      let clearReason = null;

      // Rule 1: cross-source consensus already set
      if (row.__consensusVerified === true) {
        clearReason = "consensus";
      }
      // Rule 2: confidence score is trusted
      else if (typeof row.__confidenceScore === "number" && row.__confidenceScore >= 0.60) {
        clearReason = "score";
      }
      // Rule 3: non-CS peer confirmation
      else {
        const peers = await nonCsPeersAgree(row.hobbyiqCardId, Number(row.price));
        if (peers >= 3) clearReason = "peers";
      }

      if (clearReason) {
        stats.cleared++;
        stats.reasons[clearReason]++;
        if (APPLY) {
          row.__cardsightUnverified = false;
          row.__cardsightReauditedAt = nowIso;
          row.__cardsightReauditReason = clearReason;
          await withRetry(() => sc.items.upsert(row));
        }
      } else {
        stats.keptFlagged++;
        if (APPLY) {
          row.__cardsightReauditedAt = nowIso;
          row.__cardsightReauditReason = "no-supporting-evidence";
          await withRetry(() => sc.items.upsert(row));
        }
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
        console.log(`  scanned=${stats.scanned} cleared=${stats.cleared} kept=${stats.keptFlagged} err=${stats.errors} reasons: peers=${stats.reasons.peers} consensus=${stats.reasons.consensus} score=${stats.reasons.score} peerCache=${peerCache.size}`);
      }
      if (timeExpired()) break;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  scanned:            ${stats.scanned}`);
  console.log(`  cleared (flag off):  ${stats.cleared}`);
  console.log(`    by peer confirm:   ${stats.reasons.peers}`);
  console.log(`    by consensus:      ${stats.reasons.consensus}`);
  console.log(`    by score:          ${stats.reasons.score}`);
  console.log(`  kept flagged:        ${stats.keptFlagged}`);
  console.log(`  errors:              ${stats.errors}`);
  if (!APPLY) console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
  console.log(`RELAUNCH_NEEDED=${timeExpired() ? "true" : "false"}`);
}

main().catch(e => { console.error(e); console.log("RELAUNCH_NEEDED=true"); process.exit(0); });
