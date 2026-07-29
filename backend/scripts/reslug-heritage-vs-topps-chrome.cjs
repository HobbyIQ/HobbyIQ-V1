#!/usr/bin/env node
// CF-RESLUG-HERITAGE (Drew, 2026-07-29). Backfill for PR #933 (Heritage
// data quality). Existing sold_comps rows carrying ":topps-chrome:" in
// their slug where the vendor title actually says "Topps Heritage"
// (CH tagged Heritage subsets as "Topps Chrome" via card_set_type) need
// to migrate to ":topps-heritage:" so pricing pools separate correctly.
//
// Detection: row's slug contains ":topps-chrome:" AND at least one of:
//   (a) setName contains "Heritage" (case-insensitive)
//   (b) title contains "Topps Heritage"
//   (c) rawTitle contains "Heritage"
//
// Per feedback_slug_recompute_only_improve: ONLY apply when new slug
// contains :topps-heritage: (strict improvement).
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch (e) { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

function isHeritageRow(r) {
  const setName = String(r.setName || "");
  const title = String(r.title || r.rawTitle || "");
  if (/heritage/i.test(setName)) return "setName-has-heritage";
  if (/topps\s+heritage/i.test(title)) return "title-topps-heritage";
  if (/heritage/i.test(title)) return "title-has-heritage";
  return null;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.playerName, c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(c.hobbyiqCardId, ':topps-chrome:')
  `;

  console.log(`[reslug-heritage] scanning sold_comps for :topps-chrome: rows...`);
  console.log(`  apply: ${APPLY} (set RESLUG_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} rows carry :topps-chrome: in slug\n`);

  const byReason = {};
  const patches = [];
  let alreadyCorrect = 0, notHeritage = 0, computeFailed = 0, wouldDemote = 0;

  for (const r of candidates) {
    const reason = isHeritageRow(r);
    if (!reason) { notHeritage++; continue; }
    byReason[reason] = (byReason[reason] ?? 0) + 1;

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: (r.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear),
        setKey: "Topps Heritage",       // canonical for Heritage
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: !!r.isAuto,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { alreadyCorrect++; continue; }
    if (!newSlug.includes(":topps-heritage:")) { wouldDemote++; continue; }

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      reason,
      cardNumber: r.cardNumber,
    });
  }

  console.log(`Candidates by heritage-signal:`);
  Object.entries(byReason).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`Not heritage:                ${notHeritage}`);
  console.log(`Already-correct or no-op:    ${alreadyCorrect}`);
  console.log(`Compute failed:              ${computeFailed}`);
  console.log(`Would-demote (skipped):      ${wouldDemote}`);
  console.log(`Ready to re-slug:            ${patches.length}\n`);

  if (patches.length === 0) return;

  console.log("Sample 20 patches (old → new):");
  patches.slice(0, 20).forEach(p =>
    console.log(`  [${p.reason}] ${p.cardNumber}\n    ${p.oldSlug}\n    ${p.newSlug}`)
  );

  if (!APPLY) {
    console.log("\n*** DRY-RUN COMPLETE. Set RESLUG_APPLY=true to write. ***");
    return;
  }

  console.log(`\nApplying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
