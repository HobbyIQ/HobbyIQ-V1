#!/usr/bin/env node
// CF-STAGING-BACKLOG-DRAIN (Drew, 2026-08-13: "lets drain it, we need that data
// badly").
//
// One-off bulk drain of the 3.5M `pending` rows that CF-DATACLEAN-VENDOR-FIELD-
// PATH unblocked. The hourly cron drains ~48K/day at its current limits, which
// is below the ~300K/day inbound — so the backlog needs a dedicated pass.
//
// Loops data-clean -> promotion until the backlog is gone, the wall clock runs
// out, or a cycle stops making progress (which means something is wrong and
// spinning would just burn RUs).
//
//   node scripts/drainStagingBacklog.cjs --minutes 30 --clean 2000 --promote 4000

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MINUTES = Number(val("--minutes", "30"));
// runDataCleanBatch caps its own limit at 500 (Math.min(500, opts.limit ?? 100)).
// Both jobs take an OPTIONS OBJECT — passing a bare number silently falls back
// to the default 100, which is what limited the first calibration run to
// scanned=100 per cycle and ~160 rows/min.
const CLEAN = Math.min(500, Number(val("--clean", "500")));
const PROMOTE = Number(val("--promote", "2000"));
// CF-DRAINER-WORKER-SHARDING exists precisely for this: N workers each take a
// disjoint id-prefix slice, so they do not compete for the same TOP N rows.
// Running the shards concurrently in-process multiplies throughput without
// duplicating work.
const SHARDS = Number(val("--shards", "8"));

(async () => {
  const { runDataCleanBatch } = require(path.join(__dirname, "..", "dist/services/portfolioiq/dataCleanJob.service.js"));
  const { runPromotionBatch } = require(path.join(__dirname, "..", "dist/services/portfolioiq/promotionJob.service.js"));
  const st = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("comps_staging");

  const pendingCount = async () => {
    const { resources } = await st.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.status='pending'",
    }).fetchAll();
    return resources[0] ?? 0;
  };

  const start = Date.now();
  const deadline = start + MINUTES * 60_000;
  const before = await pendingCount();
  console.log(`pending at start: ${before.toLocaleString()}   budget ${MINUTES}m   clean=${CLEAN} promote=${PROMOTE}\n`);

  let cycle = 0, totalCleaned = 0, totalPromoted = 0, idle = 0;
  while (Date.now() < deadline) {
    cycle++;
    const results = await Promise.all(
      Array.from({ length: SHARDS }, async (_, i) => {
        const shard = { index: i, total: SHARDS };
        const c = await runDataCleanBatch({ limit: CLEAN, workerShard: shard }).catch((e) => ({ error: e.message }));
        const p = await runPromotionBatch({ limit: PROMOTE, workerShard: shard }).catch((e) => ({ error: e.message }));
        return { c, p };
      }),
    );
    const c = {
      cleaned: results.reduce((n, r) => n + Number(r.c?.cleaned ?? 0), 0),
      scanned: results.reduce((n, r) => n + Number(r.c?.scanned ?? 0), 0),
      anomalies: results.reduce((n, r) => n + Number(r.c?.anomalies ?? 0), 0),
      error: results.find((r) => r.c?.error)?.c?.error,
    };
    const p = {
      promoted: results.reduce((n, r) => n + Number(r.p?.promoted ?? 0), 0),
      awaitingCatalog: results.reduce((n, r) => n + Number(r.p?.awaitingCatalog ?? 0), 0),
      errors: results.reduce((n, r) => n + Number(r.p?.errors ?? 0), 0),
      error: results.find((r) => r.p?.error)?.p?.error,
    };
    const cleaned = c.cleaned;
    const promoted = p.promoted;
    totalCleaned += cleaned; totalPromoted += promoted;

    const mins = ((Date.now() - start) / 60000).toFixed(1);
    console.log(`cycle ${String(cycle).padStart(3)} @${mins}m  cleaned=${cleaned} (scanned ${c?.scanned ?? "?"}, anomalies ${c?.anomalies ?? 0})  promoted=${promoted} (awaitingCatalog ${p?.awaitingCatalog ?? 0}, errors ${p?.errors ?? 0})`);
    if (c?.error) console.log(`   data-clean ERROR ${c.error}`);
    if (p?.error) console.log(`   promotion  ERROR ${p.error}`);

    // Stop if a full cycle moved nothing — spinning would only burn RUs.
    if (cleaned === 0 && promoted === 0) {
      if (++idle >= 3) { console.log("\n3 idle cycles — nothing left to move, stopping."); break; }
    } else idle = 0;
  }

  const after = await pendingCount();
  console.log(`\ncycles=${cycle}  cleaned=${totalCleaned.toLocaleString()}  promoted=${totalPromoted.toLocaleString()}`);
  console.log(`pending: ${before.toLocaleString()} -> ${after.toLocaleString()}  (${(before - after).toLocaleString()} drained)`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
