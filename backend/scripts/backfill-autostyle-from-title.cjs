#!/usr/bin/env node
// CF-BACKFILL-AUTOSTYLE-FROM-TITLE (Drew, 2026-07-30). 236,913 rows
// have isAuto=true but autoStyle=null. Parser's extractAutoStyle
// detects "on card"/"on-card"/"hard signed" (→ on-card) or "sticker"/
// "sticker auto" (→ sticker) from title text. Backfill applies this
// to historic rows where the field is null.
//
// On-card vs sticker matters: 15-30% FMV differential on premium autos
// (Bowman Chrome Prospect Autos, Topps Chrome Rookie Autos are
// on-card; older Panini autos are often sticker).
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=300000       — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "300000");

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
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

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[backfill-autostyle-from-title]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // isAuto=true + autoStyle null + has title
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.title, c.rawTitle
    FROM c
    WHERE c.isAuto = true
      AND (NOT IS_DEFINED(c.autoStyle) OR c.autoStyle = null)
      AND IS_STRING(c.title)
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} isAuto=true + autoStyle=null rows fetched.        \n`);

  const patches = [];
  const dist = { "on-card": 0, "sticker": 0 };
  let noHint = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    const parsed = parseListingIdentity(title);
    if (parsed.autoStyle == null) { noHint++; continue; }
    dist[parsed.autoStyle] = (dist[parsed.autoStyle] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, autoStyle: parsed.autoStyle });
  }

  console.log(`  no autoStyle hint in title: ${noHint}`);
  console.log(`  Ready to patch:              ${patches.length}`);
  console.log(`    on-card: ${dist["on-card"]}`);
  console.log(`    sticker: ${dist["sticker"]}\n`);

  if (patches.length > 0) {
    console.log(`  Sample 5:`);
    patches.slice(0,5).forEach(p =>
      console.log(`    ${p.autoStyle.padEnd(8)} ${p.id.slice(0,8)}`)
    );
  }

  if (!APPLY || patches.length === 0) {
    if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    // autoStyle doesn't affect slug — patch field only.
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/autoStyle", value: p.autoStyle },
    ]);
    done++;
    if (done % 1000 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
