#!/usr/bin/env node
// CF-PHASH-BRIDGE (Drew, 2026-07-25). Phase 1 of image-verification via
// perceptual hashing. Bridges the existing ch_sale_phashes container
// (194k rows, dhash-v1 fingerprints) onto sold_comps rows by imageUrl
// match — no re-computation needed for CH-source rows. Adds a `phash`
// field to each matched sold_comps row so downstream centroid + reslug
// logic can query in one place.
//
// Env:
//   BRIDGE_APPLY=true — persist. Default: dry-run.
//   BRIDGE_CONCURRENCY=16

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const APPLY = process.env.BRIDGE_APPLY === "true";
const CONCURRENCY = Number(process.env.BRIDGE_CONCURRENCY || "16");

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
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const ph = db.container("ch_sale_phashes");
  const sc = db.container("sold_comps");

  console.log(`[phash-bridge] loading ch_sale_phashes...`);
  const byImageUrl = new Map(); // imageUrl → hash
  const phIt = ph.items.query({ query: "SELECT c.image_url, c.hash FROM c WHERE IS_DEFINED(c.image_url) AND IS_DEFINED(c.hash)" }, { maxItemCount: 5000 });
  let phScanned = 0;
  while (phIt.hasMoreResults()) {
    const { resources } = await phIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) if (r.image_url && r.hash) byImageUrl.set(String(r.image_url), String(r.hash));
    phScanned += resources.length;
    process.stdout.write(`\r  ch_sale_phashes scanned=${phScanned} distinct-urls=${byImageUrl.size}`);
  }
  console.log(`\n  ${byImageUrl.size} distinct pHash-per-url pairs indexed\n`);

  console.log(`[phash-bridge] scanning sold_comps for matchable rows...`);
  const q = `SELECT c.id, c.cardId, c.imageUrl, c.phash FROM c WHERE IS_DEFINED(c.imageUrl) AND c.imageUrl != null AND c.imageUrl != ''`;
  const scIt = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const patches = [];
  let scanned = 0, alreadyHave = 0, noMatch = 0;
  while (scIt.hasMoreResults()) {
    const { resources } = await scIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      scanned++;
      if (r.phash) { alreadyHave++; continue; }
      const hash = byImageUrl.get(String(r.imageUrl));
      if (!hash) { noMatch++; continue; }
      patches.push({ id: r.id, partitionKey: r.cardId, hash });
    }
    process.stdout.write(`\r  scanned=${scanned} alreadyHave=${alreadyHave} noMatch=${noMatch} patches=${patches.length}`);
  }
  console.log(`\n\nSummary:`);
  console.log(`  sold_comps scanned:  ${scanned}`);
  console.log(`  already have phash:  ${alreadyHave}`);
  console.log(`  no match in bridge:  ${noMatch}`);
  console.log(`  patches ready:       ${patches.length}\n`);

  if (patches.length === 0 || !APPLY) {
    if (!APPLY && patches.length) console.log(`*** DRY-RUN. Set BRIDGE_APPLY=true to persist. ***`);
    return;
  }
  console.log(`Patching ${patches.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/phash", value: p.hash },
      { op: "set", path: "/phashAlgo", value: "dhash-v1" },
    ]);
    done++;
    if (done % 1000 === 0) process.stdout.write(`\r  patched ${done}/${patches.length}`);
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
