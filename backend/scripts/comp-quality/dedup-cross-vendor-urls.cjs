#!/usr/bin/env node
// CF-COMP-QUALITY-DEDUP (Drew, 2026-07-24). Cross-vendor URL dedup pass
// on sold_comps. Same eBay listing ingested by CardHedge AND Cardsight
// produces two rows for the same sale — contentHash includes source
// so cross-source dupes weren't caught at ingest time.
//
// Rule: group rows by exact (url, price rounded to $0.01, soldAt to date).
// Keep the row that has the most useful metadata; delete the others.
//
// Ranking to keep the best row:
//   1. source = cardsight (newer, richer parser)
//   2. has imageUrl
//   3. has parallel_id / gradeCompany populated
//   4. most-recent observedAt
//
// Env:
//   DEDUP_APPLY=true — actually delete. Default: dry-run.
//   DEDUP_CONCURRENCY=16 — parallel deletes.
//
// Usage:
//   node backend/scripts/comp-quality/dedup-cross-vendor-urls.cjs --sport baseball --min-year 2020

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const APPLY = process.env.DEDUP_APPLY === "true";
const CONCURRENCY = Number(process.env.DEDUP_CONCURRENCY || "16");

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0;
  let ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

function scoreRow(r) {
  let s = 0;
  if (r.source === "cardsight") s += 1000;   // prefer CS
  if (r.imageUrl) s += 100;
  if (r.parallel) s += 10;
  if (r.gradeCompany) s += 10;
  if (r.observedAt) { try { s += Math.floor(new Date(r.observedAt).getTime() / 86400000); } catch { /* noop */ } }
  return s;
}

async function main() {
  const sport = arg("sport", "baseball");
  const minYear = Number(arg("min-year", "2020")) || 2020;

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[dedup] scanning sold_comps sport=${sport} year>=${minYear}...`);
  console.log(`  apply: ${APPLY} (DEDUP_APPLY=true to actually delete)`);
  const q = `SELECT c.id, c.cardId, c.url, c.price, c.soldAt, c.source, c.imageUrl, c.parallel, c.gradeCompany, c.observedAt
             FROM c WHERE c.sport = @sp AND c.cardYear >= @y AND IS_DEFINED(c.url) AND c.url != null AND c.url != ''`;
  const it = sc.items.query({ query: q, parameters: [{ name: "@sp", value: sport }, { name: "@y", value: minYear }] }, { maxItemCount: 5000 });

  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanned ${rows.length}`);
  }
  console.log(`\n  total: ${rows.length} rows with URL`);

  // Group by (url, priceCents, soldAtDate)
  const groups = new Map();
  for (const r of rows) {
    const priceCents = Math.round(Number(r.price) * 100);
    const dayKey = String(r.soldAt ?? "").slice(0, 10);
    if (!priceCents || !dayKey || !r.url) continue;
    const key = `${r.url}|${priceCents}|${dayKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const dupes = [...groups.values()].filter(g => g.length > 1);
  console.log(`  duplicate groups: ${dupes.length}`);
  const toDelete = [];
  const sourceBreakdown = new Map();
  for (const g of dupes) {
    g.sort((a, b) => scoreRow(b) - scoreRow(a));
    const [keep, ...rest] = g;
    for (const del of rest) {
      toDelete.push({ id: del.id, partitionKey: del.cardId, source: del.source });
      sourceBreakdown.set(del.source ?? "unknown", (sourceBreakdown.get(del.source ?? "unknown") || 0) + 1);
    }
  }
  console.log(`  rows to delete: ${toDelete.length}`);
  console.log(`  source breakdown:`);
  [...sourceBreakdown.entries()].sort((a,b) => b[1]-a[1]).forEach(([s, n]) => console.log(`    ${s.padEnd(20)} ${n}`));

  if (!APPLY) {
    console.log("\n*** DRY-RUN. Set DEDUP_APPLY=true to actually delete. ***");
    // Show 10 examples
    console.log("\n10 example duplicate groups:");
    dupes.slice(0, 10).forEach((g, i) => {
      console.log(`  Group ${i+1}: ${g.length} rows @ ${g[0].url?.slice(0, 60)}...`);
      g.slice(0, 3).forEach(r => console.log(`    ${r.source} $${r.price} ${r.soldAt?.slice(0,10)} img=${!!r.imageUrl}`));
    });
    return;
  }

  console.log(`\nDeleting ${toDelete.length} duplicate rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(toDelete, async (d) => {
    await sc.item(d.id, d.partitionKey).delete();
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  deleted ${done}/${toDelete.length} (${rate}/s)`);
    }
  });
  console.log(`\n  deleted ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
