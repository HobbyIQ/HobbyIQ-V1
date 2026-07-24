#!/usr/bin/env node
// CF-COMP-QUALITY-ISAUTO-BACKFILL (Drew, 2026-07-24). CardHedge ingest
// doesn't tag isAuto=true for autograph card numbers (CPA-*, BCPA-*, etc.)
// even though the cardNumber prefix IS the auto boundary per Drew's
// memory `isauto-boundary-is-cardnumber-not-text`.
//
// This backfill scans sold_comps for rows where cardNumber matches the
// autograph prefix pattern AND isAuto is currently false, flips
// isAuto=true, and recomputes hobbyiqCardId with the corrected flag.
//
// Auto prefix pattern is the same one used by the Phase B pricing
// crawler (phase-b-crawl-pricing.cjs).
//
// Env:
//   ISAUTO_APPLY=true — persist changes. Default: dry-run.
//   ISAUTO_CONCURRENCY=12 — parallel patches.
//
// Usage:
//   node backend/scripts/comp-quality/backfill-isauto-from-cardnumber.cjs --sport baseball --min-year 2025

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const APPLY = process.env.ISAUTO_APPLY === "true";
const CONCURRENCY = Number(process.env.ISAUTO_CONCURRENCY || "12");

const AUTO_CARD_NUMBER_PREFIX = /^(CPA|BCPA|BCA|BCRA|BSA|BSHA|CDA|BDPA|BFA|CPAP|CRA|TAA|USA|RA|GA)-/i;

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
  const minYear = Number(arg("min-year", "2025")) || 2025;
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[isauto-backfill] scope: sport=${sport} year>=${minYear}`);
  console.log(`  apply: ${APPLY} (ISAUTO_APPLY=true to persist)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  // Only pull rows where cardNumber exists + isAuto is false/undefined.
  // Cosmos NOT operator inconsistencies push filtering to JS.
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.setName, c.sport FROM c WHERE c.sport = @sp AND c.cardYear >= @y AND IS_DEFINED(c.cardNumber) AND c.cardNumber != null AND c.cardNumber != ''`;
  const it = sc.items.query({ query: q, parameters: [{ name: "@sp", value: sport }, { name: "@y", value: minYear }] }, { maxItemCount: 5000 });

  const patches = [];
  let scanned = 0, matchedPrefix = 0, needsFlip = 0, missingIdentity = 0;
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      scanned++;
      if (!AUTO_CARD_NUMBER_PREFIX.test(r.cardNumber)) continue;
      matchedPrefix++;
      if (r.isAuto === true) continue;
      needsFlip++;
      // Try to recompute slug
      if (!r.playerName || !r.setName || !r.cardYear) { missingIdentity++; continue; }
      let newSlug;
      try {
        newSlug = computeHobbyIqCardId({
          sport: (r.sport || "baseball").toLowerCase(),
          year: Number(r.cardYear),
          setKey: r.setName,
          cardNumber: r.cardNumber,
          parallel: r.parallel || "Base",
          isAuto: true,
          printRun: r.printRun ?? null,
        });
      } catch { continue; }
      patches.push({
        id: r.id,
        partitionKey: r.cardId,
        newSlug,
        oldSlug: r.hobbyiqCardId,
      });
    }
    process.stdout.write(`\r  scanned=${scanned} matched=${matchedPrefix} needsFlip=${needsFlip} patches=${patches.length}`);
  }
  console.log();
  console.log(`\n=== Summary ===`);
  console.log(`Scanned:                 ${scanned}`);
  console.log(`Matched auto prefix:     ${matchedPrefix}`);
  console.log(`Needs isAuto=true flip:  ${needsFlip}`);
  console.log(`Skipped missing identity: ${missingIdentity}`);
  console.log(`Ready to patch:          ${patches.length}`);

  if (patches.length === 0) return;
  console.log(`\n10 sample patches:`);
  patches.slice(0, 10).forEach(p => console.log(`  ${p.oldSlug || "(none)"} → ${p.newSlug}`));

  if (!APPLY) {
    console.log("\n*** DRY-RUN. Set ISAUTO_APPLY=true to persist. ***");
    return;
  }

  console.log(`\nPatching ${patches.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/isAuto", value: true },
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  patched ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
