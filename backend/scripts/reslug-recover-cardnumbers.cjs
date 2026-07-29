#!/usr/bin/env node
// CF-RESLUG-RECOVER-CARDNUMBERS (Drew, 2026-07-29). Backfill for PR
// #935 (cardNumber recovery from title). Existing sold_comps rows
// carry an empty cardNumber slot in their slug (::) even when the
// vendor title clearly has "#BST-14" / "#136" / etc. Recover the
// cardNumber by re-parsing the title and re-slugging.
//
// Detection: row's slug contains "::" (double-colon = empty cardNumber
// slot) AND the vendor title yields a non-empty cardNumber via the
// current parseListingIdentity.
//
// Env:
//   COSMOS_CONNECTION_STRING — required
//   RESLUG_APPLY=true         — actually write (default dry-run)
//   RESLUG_CONCURRENCY=16     — parallel patches
//   RESLUG_LIMIT=N            — cap candidates fetched (default all)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "16");
const LIMIT = Number(process.env.RESLUG_LIMIT || "0");   // 0 = no cap

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

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  // Detect empty cardNumber slot via the ::: pattern (setKey :: parallel).
  const topClause = LIMIT > 0 ? `TOP ${LIMIT}` : "";
  const q = `
    SELECT ${topClause} c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.playerName, c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE (
      CONTAINS(c.hobbyiqCardId, ":::") OR
      NOT IS_DEFINED(c.cardNumber) OR
      c.cardNumber = "" OR c.cardNumber = null
    )
    AND (IS_DEFINED(c.title) OR IS_DEFINED(c.rawTitle))
  `;

  console.log(`[reslug-recover-cardnumbers] scanning sold_comps for empty-cardNumber slugs...`);
  console.log(`  apply: ${APPLY} (set RESLUG_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT || "unlimited"}`);

  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
    if (LIMIT > 0 && candidates.length >= LIMIT) break;
  }
  console.log(`\n  ${candidates.length} rows with empty cardNumber slot AND a title\n`);

  const patches = [];
  let noTitleCardnum = 0, alreadySame = 0, computeFailed = 0, parseError = 0;

  for (const r of candidates) {
    const title = String(r.title || r.rawTitle || "");
    if (!title) { noTitleCardnum++; continue; }

    let parsed;
    try {
      parsed = parseListingIdentity(title);
    } catch { parseError++; continue; }
    if (!parsed.cardNumber) { noTitleCardnum++; continue; }

    // Preserve the existing slug's setKey, sport, year, parallel,
    // isAuto, printRun — we're ONLY recovering the cardNumber slot.
    const parsedSlug = parseHobbyIqCardId(r.hobbyiqCardId);
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: (r.sport || parsedSlug?.sport || "baseball").toLowerCase(),
        year: Number(r.cardYear ?? parsedSlug?.year ?? 0),
        setKey: r.setName || parsedSlug?.setKey || "",
        cardNumber: parsed.cardNumber,
        parallel: r.parallel || parsedSlug?.parallel || "Base",
        isAuto: r.isAuto ?? parsedSlug?.isAuto ?? false,
        printRun: r.printRun ?? parsedSlug?.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { alreadySame++; continue; }

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      cardNumber: parsed.cardNumber,
    });
  }

  console.log(`No title/cardNumber:         ${noTitleCardnum}`);
  console.log(`Already same after compute:  ${alreadySame}`);
  console.log(`Parse error:                 ${parseError}`);
  console.log(`Compute failed:              ${computeFailed}`);
  console.log(`Ready to re-slug:            ${patches.length}\n`);

  if (patches.length === 0) return;

  console.log("Sample 20 patches (old → new):");
  patches.slice(0, 20).forEach(p =>
    console.log(`  cardNumber=${p.cardNumber}\n    ${p.oldSlug}\n    ${p.newSlug}`)
  );

  if (!APPLY) {
    console.log("\n*** DRY-RUN COMPLETE. Set RESLUG_APPLY=true to write. ***");
    return;
  }

  console.log(`\nApplying ${patches.length} patches at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    // Two-op patch: update slug + populate cardNumber field
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
      { op: "set", path: "/cardNumber", value: p.cardNumber },
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
