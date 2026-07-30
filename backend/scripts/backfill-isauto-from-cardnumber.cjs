#!/usr/bin/env node
// CF-BACKFILL-ISAUTO-FROM-CARDNUMBER (Drew, 2026-07-30). Fix
// historic sold_comps rows where the parser stored isAuto=false but
// the cardNumber prefix is on the confident-auto list
// (isCardNumberAutoSubset). These rows have wrong FMV placement
// because raw pool includes autos; correcting isAuto=true splits
// them into the right pool AND rewrites the slug (autoFlag is in
// slot 6 of hobbyiqCardId).
//
// Also re-slugs so /hobbyiqCardId reflects the new isAuto flag.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   BACKFILL_APPLY=true       — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16   — parallel patches
//   BACKFILL_LIMIT=100000     — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { isCardNumberAutoSubset } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "100000");

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

  console.log(`[backfill-isauto-from-cardnumber]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  scan-limit: ${LIMIT}\n`);

  // Cosmos SQL: STARTSWITH is per-prefix, no OR-of-many indexed. Use
  // regex-side matching by fetching all isAuto=false rows with a
  // cardNumber starting with any of the confident-auto letter blocks.
  // We rely on the JS filter for correctness (STARTSWITH would over-
  // match variants); Cosmos filter uses IN on the first-letter set.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun
    FROM c
    WHERE c.isAuto = false
      AND IS_STRING(c.cardNumber)
      AND LENGTH(c.cardNumber) > 3
      AND (
        STARTSWITH(c.cardNumber, "CPA", true) OR
        STARTSWITH(c.cardNumber, "CDA", true) OR
        STARTSWITH(c.cardNumber, "CRA", true) OR
        STARTSWITH(c.cardNumber, "BSA", true) OR
        STARTSWITH(c.cardNumber, "USA", true) OR
        STARTSWITH(c.cardNumber, "SCCA", true) OR
        STARTSWITH(c.cardNumber, "DAS", true) OR
        STARTSWITH(c.cardNumber, "NTS", true) OR
        STARTSWITH(c.cardNumber, "SSM", true) OR
        STARTSWITH(c.cardNumber, "CPALD", true) OR
        STARTSWITH(c.cardNumber, "CPATWH", true)
      )
  `;
  const { resources: rows } = await sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 }
  ).fetchAll();
  console.log(`  Fetched ${rows.length} isAuto=false rows with candidate cardNumber prefixes.\n`);

  const patches = [];
  const prefixDist = {};
  let skipped = 0;

  for (const r of rows) {
    // Belt-and-braces: JS-side confirm the cardNumber really matches the rule.
    if (!isCardNumberAutoSubset(r.cardNumber)) { skipped++; continue; }
    // Recompute slug with isAuto=true.
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear),
        setKey: (r.hobbyiqCardId || "").split(":")[3] || "bowman",
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: true,
        printRun: r.printRun ?? null,
      });
    } catch { skipped++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { skipped++; continue; }

    const px = String(r.cardNumber).toUpperCase().replace(/^#/, "").split("-")[0];
    prefixDist[px] = (prefixDist[px] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug });
  }

  console.log(`  Ready to patch: ${patches.length}`);
  console.log(`  Skipped (rule mismatch or no slug change): ${skipped}\n`);
  console.log(`  Prefix distribution:`);
  Object.entries(prefixDist)
    .sort((a,b) => b[1]-a[1])
    .forEach(([p,c]) => console.log(`    ${p.padEnd(10)} ${c}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p => console.log(`    ${p.oldSlug}\n    → ${p.newSlug}`));
  }

  if (!APPLY || patches.length === 0) {
    if (!APPLY) console.log(`\n*** DRY-RUN. Set BACKFILL_APPLY=true to write. ***`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
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
      process.stdout.write(`\r  applied ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  applied ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
