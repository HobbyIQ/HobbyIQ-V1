#!/usr/bin/env node
// CF-PROMOTE-WITHOUT-HTTP (Drew, 2026-08-14: "how long").
//
// Promotion via POST /api/staging/promotion is capped by App Service's 240s
// request ceiling, not by Cosmos. At ~1s/row that is ~250 rows per call; four
// shards per cycle and an ~8 minute cycle works out to ~7,500 rows/hour, i.e.
// roughly 18 DAYS for the 3.2M pending backlog.
//
// The cap is entirely an artefact of calling it over HTTP. runPromotionBatch is
// an ordinary function — invoked directly it runs until it is done. This is the
// same lever that took the anomaly requeue from 1,800 rows/min to ~60,000.
//
// Sharding matches the job's own worker-shard support, so N processes take
// disjoint id-prefix slices without contending.
//
//   node scripts/promoteLocalRunner.cjs --cycles 40
//   node scripts/promoteLocalRunner.cjs --cycles 200 --limit 5000 --shard 0 --shards 6

const path = require("node:path");
const { runPromotionBatch } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "promotionJob.service.js"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CYCLES = Number(val("--cycles", "50"));
const LIMIT = Number(val("--limit", "5000"));
const SHARD = Number(val("--shard", "-1"));
const SHARDS = Number(val("--shards", "1"));

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1);
}

(async () => {
  const tag = SHARD >= 0 && SHARDS > 1 ? `shard ${SHARD}/${SHARDS}` : "single";
  console.log(`local promotion runner — ${tag}  limit=${LIMIT}  cycles=${CYCLES}\n`);
  const started = Date.now();
  let promoted = 0, scanned = 0, awaiting = 0, errors = 0;

  for (let c = 1; c <= CYCLES; c++) {
    const opts = { limit: LIMIT };
    if (SHARD >= 0 && SHARDS > 1) opts.workerShard = { index: SHARD, total: SHARDS };
    let r;
    try {
      r = await runPromotionBatch(opts);
    } catch (e) {
      errors++;
      console.error(`  cycle ${c} threw: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    scanned += r.scanned ?? 0;
    promoted += r.promoted ?? 0;
    awaiting += r.awaitingCatalog ?? 0;
    errors += r.errors ?? 0;

    const mins = (Date.now() - started) / 60000;
    console.log(
      `  cycle ${String(c).padStart(3)}  scanned=${String(r.scanned ?? 0).padStart(5)}` +
      `  promoted=${String(r.promoted ?? 0).padStart(5)}` +
      `  awaitingCatalog=${String(r.awaitingCatalog ?? 0).padStart(5)}` +
      `  [${Math.round(promoted / Math.max(mins, 0.01))}/min]`,
    );

    // Nothing left in this shard's promotable set — stop rather than spin.
    if ((r.scanned ?? 0) === 0) { console.log("  nothing promotable left; stopping."); break; }
  }

  const mins = (Date.now() - started) / 60000;
  console.log(`\nscanned          : ${scanned.toLocaleString()}`);
  console.log(`PROMOTED         : ${promoted.toLocaleString()}`);
  console.log(`awaiting catalog : ${awaiting.toLocaleString()}`);
  console.log(`errors           : ${errors}`);
  console.log(`elapsed          : ${mins.toFixed(1)} min  (${Math.round(promoted / Math.max(mins, 0.01))}/min)`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
