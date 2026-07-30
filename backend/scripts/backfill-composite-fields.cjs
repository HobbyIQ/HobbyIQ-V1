#!/usr/bin/env node
// CF-BACKFILL-COMPOSITE-FIELDS (Drew, 2026-07-30). Populate the 6-axis
// composite parallel identity on historic sold_comps rows. Emission
// on new writes handled by soldCompsStore.recordSoldComp; this
// backfill catches everything that already exists.
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=500000       — max rows scanned per pass

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseParallelComposite } = require(path.join(backend, "dist/services/portfolioiq/parseParallelComposite.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
// Higher default concurrency for composite backfill — Cosmos patch
// on 3M-row corpus needs the throughput. 32 is a reasonable balance
// between wall-clock and 429 pressure; can bump to 64 if TPU headroom
// is present.
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "32");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "500000");

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

  console.log(`[backfill-composite-fields]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // Fetch rows without composite. Broad — no other filter.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.title, c.rawTitle, c.cardNumber, c.sport, c.setName
    FROM c
    WHERE (NOT IS_DEFINED(c.composite) OR c.composite = null)
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
    if (rows.length % 25000 < 5000) process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} rows without composite fields.        \n`);

  const patches = [];
  const editionDist = {}, colorDist = {}, finishDist = {};
  let confidenceHigh = 0, confidenceMedium = 0, confidenceLow = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) continue;
    let composite;
    try {
      const c = parseParallelComposite(title, r.cardNumber ?? null, {
        sport: r.sport ?? null,
        setName: r.setName ?? null,
      });
      composite = {
        edition: c.edition,
        insertSet: c.insertSet,
        colorFamily: c.colorFamily,
        finishModifier: c.finishModifier,
        isRefractor: c.isRefractor,
        confidence: c.confidence,
      };
    } catch { continue; }

    // Skip rows where every axis came back null and confidence low —
    // adds nothing over what we already have.
    if (composite.edition === null && composite.insertSet === null
        && composite.colorFamily === null && composite.finishModifier === null
        && composite.isRefractor === false && composite.confidence === "low") {
      continue;
    }

    if (composite.edition) editionDist[composite.edition] = (editionDist[composite.edition] ?? 0) + 1;
    if (composite.colorFamily) colorDist[composite.colorFamily] = (colorDist[composite.colorFamily] ?? 0) + 1;
    if (composite.finishModifier) finishDist[composite.finishModifier] = (finishDist[composite.finishModifier] ?? 0) + 1;
    if (composite.confidence === "high") confidenceHigh++;
    else if (composite.confidence === "medium") confidenceMedium++;
    else confidenceLow++;

    patches.push({ id: r.id, partitionKey: r.cardId, composite });
  }

  console.log(`  Ready to patch: ${patches.length}\n`);
  console.log(`  Edition distribution:`);
  Object.entries(editionDist).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .forEach(([k,v]) => console.log(`    ${String(v).padStart(6)}  ${k}`));
  console.log(`\n  Color family distribution (top 15):`);
  Object.entries(colorDist).sort((a,b)=>b[1]-a[1]).slice(0,15)
    .forEach(([k,v]) => console.log(`    ${String(v).padStart(6)}  ${k}`));
  console.log(`\n  Finish modifier distribution (top 10):`);
  Object.entries(finishDist).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .forEach(([k,v]) => console.log(`    ${String(v).padStart(6)}  ${k}`));
  console.log(`\n  Confidence: high=${confidenceHigh} medium=${confidenceMedium} low=${confidenceLow}`);

  if (!APPLY || patches.length === 0) {
    if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/composite", value: p.composite },
    ]);
    done++;
    if (done % 2000 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
