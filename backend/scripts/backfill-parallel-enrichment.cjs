#!/usr/bin/env node
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ DISARMED 2026-08-20. DO NOT RUN WITH BACKFILL_APPLY=true.                │
// └──────────────────────────────────────────────────────────────────────────┘
//
// CF-DISARM-PARALLEL-ENRICHMENT. This script re-derives the WHOLE slug through
// computeHobbyIqCardId, not just the parallel segment its name advertises. Its
// dry run on 2026-08-19 was caught pushing
//
//     hiq:baseball:2026:bowman:cpa-eha:...   ->   ...:bowman-chrome:cpa-eha:...
//
// which would have re-split the CPA- pool that had just been merged hours
// earlier — the very split that priced a gold CPA-MG auto at $6.90 against $187
// paid. A full re-derive is only as good as the vendor title, and vendor titles
// routinely omit a setKey or parallel the existing slug already had right.
//
// It also earns almost nothing now. Re-running it over 20,000 candidate rows
// improved 6, because the 2026-07-30 pass already harvested what the parser can
// see. The remaining "base with a colour in the title" rows are not recoverable
// from text: the parallel is absent at the SOURCE (identical generic titles
// across a $1.25-$725 spread), which is why the colour work moved to the image
// path.
//
// Left in the tree rather than deleted because the dry-run output is useful
// evidence and the measurement above should not have to be redone. If parallel
// enrichment is wanted again, it must patch ONLY the parallel segment and carry
// every other segment across untouched — the shape reslug-setkey-segment uses.
//
// The guard below refuses to write. Removing it is a decision, not an accident.
if (process.env.BACKFILL_APPLY === "true" && process.env.I_HAVE_READ_CF_DISARM !== "yes") {
  console.error([
    "",
    "REFUSING TO RUN: backfill-parallel-enrichment is disarmed.",
    "",
    "It re-derives the ENTIRE slug, not just the parallel, and was caught in dry",
    "run pushing bowman:cpa-eha back to bowman-chrome:cpa-eha — re-splitting a",
    "pool merged hours earlier. It also improved only 6 rows in 20,000.",
    "",
    "If you truly intend this, read the header, then set:",
    "  I_HAVE_READ_CF_DISARM=yes",
    "",
  ].join("\n"));
  process.exit(1);
}
//
// CF-BACKFILL-PARALLEL-ENRICHMENT (Drew, 2026-07-30). 56,510 rows have
// parallel="Base" but title mentions a color word ("gold", "red",
// "orange", "purple", "pink"). Re-run extractParallel via
// parseListingIdentity and patch when it returns non-"Base".
//
// Rewrites both /parallel AND /hobbyiqCardId (parallel is slot 5).
// Only-improve guardrail: new parallel must be MORE specific than old
// (never demote a colored refractor to Base).
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=100000       — max rows scanned per pass

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, matchKnownProductLine } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

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

  console.log(`[backfill-parallel-enrichment]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // parallel is base + title mentions a color word (broad Cosmos-side
  // filter; parseListingIdentity is the strict per-row extractor).
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (c.parallel = "Base" OR c.parallel = "base" OR c.parallel = "Refractor")
      AND IS_STRING(c.title)
      AND (
        CONTAINS(LOWER(c.title),"gold") OR
        CONTAINS(LOWER(c.title),"red ") OR CONTAINS(LOWER(c.title),"red/") OR
        CONTAINS(LOWER(c.title),"orange") OR
        CONTAINS(LOWER(c.title),"purple") OR
        CONTAINS(LOWER(c.title),"pink") OR
        CONTAINS(LOWER(c.title),"blue ") OR CONTAINS(LOWER(c.title),"blue/") OR
        CONTAINS(LOWER(c.title),"green") OR
        CONTAINS(LOWER(c.title),"aqua") OR
        CONTAINS(LOWER(c.title),"yellow") OR
        CONTAINS(LOWER(c.title),"black") OR
        CONTAINS(LOWER(c.title),"sapphire") OR
        CONTAINS(LOWER(c.title),"shimmer") OR
        CONTAINS(LOWER(c.title),"lava") OR
        CONTAINS(LOWER(c.title),"wave") OR
        CONTAINS(LOWER(c.title),"speckle") OR
        CONTAINS(LOWER(c.title),"mojo") OR
        CONTAINS(LOWER(c.title),"mega") OR
        CONTAINS(LOWER(c.title),"xfractor") OR
        CONTAINS(LOWER(c.title),"x-fractor") OR
        CONTAINS(LOWER(c.title),"superfractor") OR
        CONTAINS(LOWER(c.title),"prizm")
      )
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
  console.log(`\r  ${rows.length} base/refractor rows with color-word in title.        \n`);

  const patches = [];
  const dist = {};
  let noImprovement = 0, computeFailed = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    const parsed = parseListingIdentity(title);
    const newParallel = parsed.parallel;
    const oldParallel = String(r.parallel || "").toLowerCase();

    // Skip if extractor returned Base or same as current.
    if (!newParallel || newParallel.toLowerCase() === "base") { noImprovement++; continue; }
    if (newParallel.toLowerCase() === oldParallel) { noImprovement++; continue; }
    // Only-improve: new must be strictly more specific.
    // Reject if new is bare "Refractor" but old was already "Refractor".
    if (oldParallel === "refractor" && newParallel.toLowerCase() === "refractor") { noImprovement++; continue; }

    // CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Never default to
    // "bowman" — that silent fallback was landing Panini/Topps rows in
    // the Bowman namespace. Precedence: title-derived (source of truth)
    // > existing slug's setKey > skip.
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
        parallel: newParallel,
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noImprovement++; continue; }

    dist[newParallel] = (dist[newParallel] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId, newSlug,
      newParallel,
    });
  }

  console.log(`  no improvement:  ${noImprovement}`);
  console.log(`  compute failed:  ${computeFailed}`);
  console.log(`  Ready to patch:  ${patches.length}\n`);
  console.log(`  New parallel distribution (top 20):`);
  Object.entries(dist)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([p, c]) => console.log(`    ${String(c).padStart(5)}  ${p}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5:`);
    patches.slice(0,5).forEach(p =>
      console.log(`    ${p.newParallel}\n      ${p.oldSlug}\n      → ${p.newSlug}`)
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
      { op: "set", path: "/parallel", value: p.newParallel },
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
