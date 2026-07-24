#!/usr/bin/env node
// CF-COMP-QUALITY-EMPTY-SETKEY (Drew, 2026-07-24). Consolidates
// sold_comps rows with empty-setKey slugs (`hiq:sport:year::...` or
// `hiq:sport:year:::...`) into their canonical slug via card_catalog
// lookup by (year, cardNumber, isAuto).
//
// Only remaps when card_catalog has EXACTLY ONE match — ambiguous
// cases (Ohtani #1 exists in Topps AND Topps Chrome AND Stadium Club)
// stay as-is to avoid mis-consolidation.
//
// Env:
//   EMPTY_SETKEY_APPLY=true — persist. Default: dry-run.
//   EMPTY_SETKEY_CONCURRENCY=12
//
// Usage:
//   node backend/scripts/comp-quality/consolidate-empty-setkey-slugs.cjs --sport baseball --min-year 2020

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const APPLY = process.env.EMPTY_SETKEY_APPLY === "true";
const CONCURRENCY = Number(process.env.EMPTY_SETKEY_CONCURRENCY || "12");

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

async function main() {
  const sport = arg("sport", "baseball");
  const minYear = Number(arg("min-year", "2020")) || 2020;
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");
  const cc = client.database("hobbyiq").container("card_catalog");

  console.log(`[empty-setKey-consolidate] scope: sport=${sport} year>=${minYear}`);
  console.log(`  apply: ${APPLY}`);

  // Load card_catalog cardsight + baseball → build index by (year|cardNumber|isAuto?)
  // The releaseName is what becomes setKey in the recomputed slug.
  console.log("  loading card_catalog for lookup...");
  const parQ = `SELECT c.year, c.number, c.releaseName, c.attributes, c.setName FROM c WHERE c.source = 'cardsight' AND c.sport = @sp`;
  const parIt = cc.items.query({ query: parQ, parameters: [{ name: "@sp", value: sport }] }, { maxItemCount: 5000 });
  const byYearNumber = new Map();
  let catalogCount = 0;
  while (parIt.hasMoreResults()) {
    const { resources } = await parIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const c of resources) {
      const key = `${c.year}|${String(c.number || "").toUpperCase()}`;
      if (!byYearNumber.has(key)) byYearNumber.set(key, new Set());
      // Add release name as canonical setKey candidate
      if (c.releaseName) byYearNumber.get(key).add(c.releaseName);
      catalogCount++;
    }
    process.stdout.write(`\r  catalog ${catalogCount}`);
  }
  console.log(`\n  ${byYearNumber.size} (year, number) keys in catalog`);

  // Now scan sold_comps for empty-setKey slugs and try to remap.
  console.log("  scanning sold_comps for empty-setKey slugs...");
  const scQ = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.setName, c.sport FROM c WHERE c.sport = @sp AND c.cardYear >= @y AND STARTSWITH(c.hobbyiqCardId, 'hiq:${sport}:') AND CONTAINS(c.hobbyiqCardId, '::')`;
  const scIt = sc.items.query({ query: scQ, parameters: [{ name: "@sp", value: sport }, { name: "@y", value: minYear }] }, { maxItemCount: 5000 });
  const rows = [];
  while (scIt.hasMoreResults()) {
    const { resources } = await scIt.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanned ${rows.length}`);
  }
  console.log(`\n  ${rows.length} empty-setKey rows`);

  const patches = [];
  let noCardNumber = 0, ambiguous = 0, unmatched = 0, noYear = 0;
  for (const r of rows) {
    if (!r.cardNumber || !r.cardYear) { noCardNumber++; continue; }
    if (!r.playerName) continue;
    const key = `${r.cardYear}|${String(r.cardNumber).toUpperCase()}`;
    const releaseNames = byYearNumber.get(key);
    if (!releaseNames || releaseNames.size === 0) { unmatched++; continue; }
    if (releaseNames.size > 1) { ambiguous++; continue; }
    const releaseName = [...releaseNames][0];
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: (r.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear),
        setKey: releaseName,
        cardNumber: r.cardNumber,
        parallel: r.parallel || "Base",
        isAuto: !!r.isAuto,
        printRun: r.printRun ?? null,
      });
    } catch { continue; }
    if (newSlug === r.hobbyiqCardId) continue;   // no change
    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      newSlug,
      newSetName: releaseName,
      oldSlug: r.hobbyiqCardId,
    });
  }
  console.log(`\n=== Summary ===`);
  console.log(`  rows scanned:              ${rows.length}`);
  console.log(`  no cardNumber/year:        ${noCardNumber}`);
  console.log(`  no catalog match:          ${unmatched}`);
  console.log(`  ambiguous (multiple):      ${ambiguous}`);
  console.log(`  patches ready:             ${patches.length}`);

  if (patches.length === 0) return;
  console.log("\n10 sample patches:");
  patches.slice(0, 10).forEach(p => console.log(`  ${p.oldSlug} → ${p.newSlug}`));

  if (!APPLY) {
    console.log("\n*** DRY-RUN. Set EMPTY_SETKEY_APPLY=true to persist. ***");
    return;
  }

  console.log(`\nPatching ${patches.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
      { op: "set", path: "/setName", value: p.newSetName },
    ]);
    done++;
    if (done % 250 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  patched ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
