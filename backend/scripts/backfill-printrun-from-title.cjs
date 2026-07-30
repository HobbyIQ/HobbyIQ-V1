#!/usr/bin/env node
// CF-BACKFILL-PRINTRUN-FROM-TITLE (Drew, 2026-07-30). Extract printRun
// from vendor titles for rows where the field is null but the title
// contains a clear "/N" or "M/N" pattern. Rewrites both the printRun
// field AND the slug (num-N suffix goes in the trailing slug slot).
//
// Uses parseListingIdentity so extraction stays consistent with the
// live parser (X/Y serial → denominator; /N standalone with 1<=N<=5000
// sanity bound to avoid grabbing years like "/2024").
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=16      — parallel patches
//   BACKFILL_LIMIT=200000        — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, matchKnownProductLine } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "16");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "200000");

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

  console.log(`[backfill-printrun-from-title]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // Fetch printRun-missing rows whose title contains a "/" (necessary
  // for a print run to exist in text). Broad; JS-side extractor is
  // the strict filter.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (NOT IS_DEFINED(c.printRun) OR c.printRun = null)
      AND IS_STRING(c.title)
      AND CONTAINS(c.title, "/")
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
  console.log(`\r  ${rows.length} printRun-null rows with "/" in title.        \n`);

  const patches = [];
  const printRunDist = {};
  let noPrintRunInTitle = 0, computeFailed = 0, noSlugChange = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    let parsed;
    try {
      parsed = parseListingIdentity(title);
    } catch { noPrintRunInTitle++; continue; }
    if (parsed.printRun == null) { noPrintRunInTitle++; continue; }

    // CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Never default to
    // "bowman" — that silent fallback was landing Panini/Topps rows in
    // the Bowman namespace. Precedence: title-derived > existing slug > skip.
    const setKey = matchKnownProductLine(title)
      || (r.hobbyiqCardId || "").split(":")[3]
      || null;
    if (!setKey) { computeFailed++; continue; }

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear),
        setKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: parsed.printRun,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noSlugChange++; continue; }

    printRunDist[parsed.printRun] = (printRunDist[parsed.printRun] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId, newSlug,
      newPrintRun: parsed.printRun,
    });
  }

  console.log(`  no printRun in title: ${noPrintRunInTitle}`);
  console.log(`  compute failed:       ${computeFailed}`);
  console.log(`  no slug change:       ${noSlugChange}`);
  console.log(`  Ready to patch:       ${patches.length}\n`);

  console.log(`  Print-run distribution (top 20):`);
  Object.entries(printRunDist)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([n, ct]) => console.log(`    /${String(n).padEnd(5)} ${ct}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p =>
      console.log(`    /${p.newPrintRun}: ${p.oldSlug}\n    →         ${p.newSlug}`)
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
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/printRun", value: p.newPrintRun },
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
