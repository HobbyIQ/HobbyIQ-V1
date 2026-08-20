#!/usr/bin/env node
// CF-AWAITING-CATALOG-LIVELOCK (Drew, 2026-08-13).
//
// Companion to the promotion fix. A staging row lands in `awaiting-catalog`
// when its sale is real but no catalog checklist describes the card yet;
// recordSoldComp has already filed a seed asking for that checklist.
//
// Those rows are NOT dead — they promote unchanged once the checklist lands.
// This flips them back to `clean` so the next promotion run picks them up.
// Run it after ingesting new checklists (drainCatalogSeedQueue, Beckett
// imports, any catalog backfill).
//
// Why they need their own status at all: promotion selects
//   SELECT TOP @n * ... WHERE c.status IN ('clean','verified')
//   ORDER BY c.observedAt DESC
// which is deterministic. Leaving unmatched rows in `clean` meant every run
// re-selected the same newest N and promoted nothing — measured on prod as
// scanned=60, promoted=0, awaitingCatalog=60.
//
// Idempotent: a row whose card is still missing simply returns to
// `awaiting-catalog` on the next promotion pass. Costs a scan, loses nothing.
//
// Dry-run by default.
//
//   node scripts/requeueAwaitingCatalog.cjs
//   node scripts/requeueAwaitingCatalog.cjs --apply --max 500000
//   node scripts/requeueAwaitingCatalog.cjs --apply --shard 0 --shards 4

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX = Number(val("--max", "100000"));
const PAGE = Number(val("--page", "1000"));
const CONCURRENCY = Number(val("--concurrency", "48"));
const SHARD = Number(val("--shard", "-1"));
const SHARDS = Number(val("--shards", "1"));
/** Only requeue rows that have been waiting at least this long (minutes).
 *  Guards against fighting a promotion run that is writing right now. */
const MIN_AGE_MIN = Number(val("--min-age-min", "0"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const st = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq")
  .container("comps_staging");

const HEX = "0123456789abcdef".split("");
function shardClause() {
  if (SHARD < 0 || SHARDS <= 1) return "";
  const mine = HEX.filter((_, i) => i % SHARDS === SHARD % SHARDS);
  return mine.length ? ` AND (${mine.map((c) => `STARTSWITH(c.id, '${c}')`).join(" OR ")})` : "";
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const stats = { scanned: 0, requeued: 0, tooRecent: 0, errors: 0 };

async function handle(row) {
  stats.scanned++;
  if (MIN_AGE_MIN > 0) {
    const since = Date.parse(row.awaitingCatalogSince || "");
    if (Number.isFinite(since) && (Date.now() - since) < MIN_AGE_MIN * 60000) {
      stats.tooRecent++; return;
    }
  }
  if (!APPLY) { stats.requeued++; return; }
  try {
    // Patch, not replace — three fields instead of the whole document.
    await st.item(row.id, row.hobbyiqCardId).patch([
      { op: "set", path: "/status", value: "clean" },
      { op: "set", path: "/catalogRetryAt", value: new Date().toISOString() },
    ]);
    stats.requeued++;
  } catch (e) {
    stats.errors++;
    if (stats.errors <= 3) console.error("  write error:", String(e && e.message).slice(0, 140));
  }
}

(async () => {
  const label = SHARD >= 0 && SHARDS > 1 ? `  shard ${SHARD}/${SHARDS}` : "";
  console.log(`requeue awaiting-catalog → clean — ${APPLY ? "APPLY" : "DRY RUN"}  max=${MAX}${label}\n`);

  const iter = st.items.query({
    query: `SELECT c.id, c.hobbyiqCardId, c.awaitingCatalogSince FROM c WHERE c.status = 'awaiting-catalog'${shardClause()}`,
  }, { maxItemCount: PAGE });

  const started = Date.now();
  let batch = 0;
  while (iter.hasMoreResults() && stats.scanned < MAX) {
    const { resources } = await iter.fetchNext();
    // Cross-partition queries return empty pages while more results remain —
    // trust hasMoreResults(), not the page size.
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, handle);
    if (++batch % 10 === 0) {
      const rate = Math.round(stats.scanned / Math.max((Date.now() - started) / 60000, 0.001));
      console.log(`   ...${stats.scanned} scanned, ${stats.requeued} ${APPLY ? "requeued" : "would requeue"}  [${rate}/min]`);
    }
  }

  console.log(`\nscanned  : ${stats.scanned}`);
  console.log(`  ${APPLY ? "REQUEUED" : "would requeue"}: ${stats.requeued}`);
  if (MIN_AGE_MIN > 0) console.log(`  too recent: ${stats.tooRecent}`);
  console.log(`  errors : ${stats.errors}`);
  if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
