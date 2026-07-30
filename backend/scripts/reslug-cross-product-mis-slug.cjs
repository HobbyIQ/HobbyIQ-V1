#!/usr/bin/env node
// CF-RESLUG-CROSS-PRODUCT-MIS-SLUG (Drew, 2026-07-30). Ladder audit
// surfaced rows where the slug says Bowman/Bowman-Chrome but the title
// clearly identifies as Panini / Topps Finest / etc. Root cause: three
// backfill scripts had `setKey: ... || "bowman"` as a silent fallback
// that landed cross-product rows in the Bowman namespace. Source bugs
// fixed in the same PR; this script cleans up the existing bad rows.
//
// Approach:
//   1. Scan rows where the slug's setKey slot is bowman* (any Bowman
//      variant) AND the title contains a clear non-Bowman product signal.
//   2. Derive the true setKey via matchKnownProductLine(title).
//   3. Only-improve guardrail: patch only when the derived setKey is a
//      DIFFERENT known product line (never demote a valid Bowman row to
//      unknown fallback slugify).
//   4. Rewrite hobbyiqCardId with the corrected setKey.
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

  console.log(`[reslug-cross-product-mis-slug]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // Query rows where slug's setKey position (slot 3, between :year: and
  // :cardNumber:) is bowman-family AND title contains a distinct
  // non-Bowman signal. The setKey slot is bracketed by two ":" — we
  // check the exact strings that would appear in a mis-slugged row.
  //
  // Slug format: hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallel}:{autoFlag}
  // We look for ":bowman:", ":bowman-chrome:", etc. in the slug string.
  //
  // Cross-product signal in title: "panini", "topps finest", "topps
  // chrome", "prizm", "select", "playoff", "score", "donruss", "optic",
  // "contenders", "immaculate", "flawless", "national treasures".
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.cardNumber,
      c.parallel, c.isAuto, c.printRun, c.title, c.rawTitle
    FROM c
    WHERE IS_STRING(c.hobbyiqCardId)
      AND IS_STRING(c.title)
      AND (
        CONTAINS(c.hobbyiqCardId, ":bowman:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-chrome:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-paper:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-draft:") OR
        CONTAINS(c.hobbyiqCardId, ":bowman-chrome-draft:")
      )
      AND (
        CONTAINS(LOWER(c.title), "panini") OR
        CONTAINS(LOWER(c.title), "prizm") OR
        CONTAINS(LOWER(c.title), "select") OR
        CONTAINS(LOWER(c.title), "playoff") OR
        CONTAINS(LOWER(c.title), "donruss") OR
        CONTAINS(LOWER(c.title), "optic") OR
        CONTAINS(LOWER(c.title), "contenders") OR
        CONTAINS(LOWER(c.title), "immaculate") OR
        CONTAINS(LOWER(c.title), "flawless") OR
        CONTAINS(LOWER(c.title), "national treasures") OR
        CONTAINS(LOWER(c.title), "mosaic") OR
        CONTAINS(LOWER(c.title), "obsidian") OR
        CONTAINS(LOWER(c.title), "chronicles") OR
        CONTAINS(LOWER(c.title), "topps finest") OR
        CONTAINS(LOWER(c.title), "topps chrome") OR
        CONTAINS(LOWER(c.title), "topps heritage") OR
        CONTAINS(LOWER(c.title), "stadium club") OR
        CONTAINS(LOWER(c.title), "upper deck") OR
        CONTAINS(LOWER(c.title), "fleer")
      )
  `;

  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 },
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} candidate rows found.        \n`);

  const patches = [];
  const setKeyDist = {};
  const bowmanBucketDist = {};
  let noSetKeyImprovement = 0, computeFailed = 0, tieAcceptedBowman = 0;

  for (const r of rows) {
    const title = String(r.title || r.rawTitle || "");
    const existingSetKey = String(r.hobbyiqCardId || "").split(":")[3] || "";

    // Skip mis-formatted slugs.
    if (!existingSetKey) { noSetKeyImprovement++; continue; }
    if (!existingSetKey.startsWith("bowman")) { noSetKeyImprovement++; continue; }

    // Title-derived TRUE setKey.
    const derivedSetKey = matchKnownProductLine(title);
    if (!derivedSetKey) { noSetKeyImprovement++; continue; }

    // Only patch when derived is DIFFERENT and NOT a bowman-family (we're
    // fixing cross-product mis-slugs, not renaming within Bowman).
    if (derivedSetKey === existingSetKey) { noSetKeyImprovement++; continue; }
    if (derivedSetKey.startsWith("bowman")) { tieAcceptedBowman++; continue; }

    // Recompute the slug with the corrected setKey.
    let newSlug;
    try {
      newSlug = computeHobbyIqCardId({
        sport: r.sport || "baseball",
        year: Number(r.cardYear) || 0,
        setKey: derivedSetKey,
        cardNumber: r.cardNumber || "",
        parallel: r.parallel || "Base",
        isAuto: r.isAuto === true,
        printRun: r.printRun ?? null,
      });
    } catch { computeFailed++; continue; }
    if (!newSlug || newSlug === r.hobbyiqCardId) { noSetKeyImprovement++; continue; }

    setKeyDist[derivedSetKey] = (setKeyDist[derivedSetKey] ?? 0) + 1;
    bowmanBucketDist[existingSetKey] = (bowmanBucketDist[existingSetKey] ?? 0) + 1;
    patches.push({
      id: r.id, partitionKey: r.cardId,
      oldSlug: r.hobbyiqCardId,
      newSlug,
      oldSetKey: existingSetKey,
      newSetKey: derivedSetKey,
      title: title.slice(0, 100),
    });
  }

  console.log(`  no setKey improvement:  ${noSetKeyImprovement}`);
  console.log(`  tie-accepted (bowman → bowman variant, skipped):  ${tieAcceptedBowman}`);
  console.log(`  compute failed:  ${computeFailed}`);
  console.log(`  Ready to patch:  ${patches.length}\n`);
  console.log(`  Corrected setKey distribution (top 20):`);
  Object.entries(setKeyDist).sort((a,b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(5)}  ${k}`));
  console.log(`\n  Original mis-slugged bucket distribution:`);
  Object.entries(bowmanBucketDist).sort((a,b) => b[1] - a[1])
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(5)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 5 patches:`);
    patches.slice(0, 5).forEach(p => {
      console.log(`    ${p.oldSetKey} → ${p.newSetKey}`);
      console.log(`      old: ${p.oldSlug}`);
      console.log(`      new: ${p.newSlug}`);
      console.log(`      title: ${p.title}\n`);
    });
  }

  if (!APPLY || patches.length === 0) {
    console.log(`\n  Dry-run / no work. Re-dispatch with BACKFILL_APPLY=true to apply.`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches (concurrency ${CONCURRENCY})...`);
  const t0 = Date.now();
  let done = 0;
  const { ok, err } = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
    ]);
    if (++done % 500 === 0) process.stdout.write(`\r    ${done}/${patches.length} patched`);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r    ${done}/${patches.length} patched (${secs}s)  ok=${ok} err=${err}`);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  patched:  ${ok}`);
  console.log(`  errors:   ${err}`);
}

main().catch(e => { console.error(e); process.exit(1); });
