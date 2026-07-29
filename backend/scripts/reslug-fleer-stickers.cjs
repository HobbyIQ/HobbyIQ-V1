#!/usr/bin/env node
// CF-RESLUG-FLEER-STICKERS (Drew, 2026-07-29). Backfill for PR #937.
// Existing sold_comps rows for Fleer Sticker basketball inserts landed
// under setKey=bowman (fallback default) with sport=baseball. Rewrite
// to the correct fleer-stickers setKey + basketball sport.
//
// Detection: row's slug contains :bowman: AND title has "Fleer Sticker".
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

function isFleerStickerRow(r) {
  const setName = String(r.setName || "");
  const title = String(r.title || r.rawTitle || "");
  if (/fleer\s+stickers?/i.test(setName)) return "setName-fleer-stickers";
  if (/fleer\s+stickers?/i.test(title)) return "title-fleer-stickers";
  return null;
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  // Fleer Sticker rows fell into the "bowman" default because
  // inferSetKeyFromTitle had no matching rule. They may also be in
  // any sport-tagged slug — scan all sports.
  const q = `
    SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
           c.playerName, c.setName, c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE CONTAINS(LOWER(c.title), 'fleer sticker')
       OR CONTAINS(LOWER(c.rawTitle), 'fleer sticker')
       OR CONTAINS(LOWER(c.setName), 'fleer sticker')
  `;

  console.log(`[reslug-fleer-stickers] scanning sold_comps for Fleer Sticker titles...`);
  console.log(`  apply: ${APPLY} (set RESLUG_APPLY=true to write)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const candidates = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) candidates.push(...resources);
    process.stdout.write(`\r  scanned ${candidates.length}`);
  }
  console.log(`\n  ${candidates.length} rows have Fleer Sticker signals\n`);

  const byReason = {};
  const patches = [];
  let notSticker = 0, alreadyCorrect = 0, computeFailed = 0, wouldDemote = 0, alreadySticker = 0;

  for (const r of candidates) {
    const slug = String(r.hobbyiqCardId ?? "");
    // Skip rows already correctly slugged
    if (/:fleer-stickers:/.test(slug)) { alreadySticker++; continue; }

    const reason = isFleerStickerRow(r);
    if (!reason) { notSticker++; continue; }
    byReason[reason] = (byReason[reason] ?? 0) + 1;

    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: "basketball",              // Fleer Stickers = basketball
        year: Number(r.cardYear),
        setKey: "Fleer Stickers",
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: !!r.isAuto,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }

    if (!newSlug || newSlug === r.hobbyiqCardId) { alreadyCorrect++; continue; }
    if (!newSlug.includes(":fleer-stickers:")) { wouldDemote++; continue; }

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      reason,
      cardNumber: r.cardNumber,
    });
  }

  console.log(`Candidates by fleer-sticker-signal:`);
  Object.entries(byReason).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`Already Fleer Stickers:      ${alreadySticker}`);
  console.log(`Not sticker:                 ${notSticker}`);
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
    // Fleer Stickers backfill also updates the sport field on the row,
    // since the row's own sport was likely baseball. Two-op patch.
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
      { op: "set", path: "/sport", value: "basketball" },
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
