#!/usr/bin/env node
// CF-BACKFILL-INSERT-SETKEY (Drew, 2026-07-30). Move insert cards
// out of the base-product FMV pool by rewriting setKey to a compound
// form. Example:
//   OLD: hiq:baseball:2024:bowman:btp-10:refractor:no-auto
//   NEW: hiq:baseball:2024:bowman-scouts-top-100:btp-10:refractor:no-auto
//
// Detection via detectInsertSet(cardNumber) which returns the insert
// slug when the cardNumber prefix matches Drew's curated baseball
// insert vocabulary (BTP/BSP/DPP/MR/TT/54F/HRC/SMLB/CC/HA/FS/USC/NAP/
// TAN/BF/NF/GOAT + anniversary regex).
//
// Surgical rewrite: split old slug on ":", replace setKey slot (3)
// only, join back. Preserves cardNumber/parallel/isAuto/printRun.
// Bypasses normalizeSetKey which would otherwise collapse the compound
// back to the base product.
//
// Guardrails:
//   - Skip when detectInsertSet returns null
//   - Skip when new setKey already contains the insert slug (idempotent)
//   - Only touch baseball rows (that's Drew's vocab scope)
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   BACKFILL_APPLY=true         — actually write
//   BACKFILL_CONCURRENCY=16     — parallel patches
//   BACKFILL_LIMIT=200000       — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { detectInsertSet } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));

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

  console.log(`[backfill-insert-setkey]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}\n`);

  // Enumerate every insert prefix. STARTSWITH-based Cosmos filter;
  // JS-side detectInsertSet is the strict test.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.cardNumber
    FROM c
    WHERE c.sport = "baseball"
      AND IS_STRING(c.cardNumber)
      AND LENGTH(c.cardNumber) > 3
      AND (
        STARTSWITH(c.cardNumber, "BTP-", true) OR
        STARTSWITH(c.cardNumber, "BSP-", true) OR
        STARTSWITH(c.cardNumber, "DPP-", true) OR
        STARTSWITH(c.cardNumber, "MR-", true) OR
        STARTSWITH(c.cardNumber, "TT-", true) OR
        STARTSWITH(c.cardNumber, "54F-", true) OR
        STARTSWITH(c.cardNumber, "HRC-", true) OR
        STARTSWITH(c.cardNumber, "SMLB-", true) OR
        STARTSWITH(c.cardNumber, "CC-", true) OR
        STARTSWITH(c.cardNumber, "HA-", true) OR
        STARTSWITH(c.cardNumber, "FS-", true) OR
        STARTSWITH(c.cardNumber, "USC-", true) OR
        STARTSWITH(c.cardNumber, "NAP-", true) OR
        STARTSWITH(c.cardNumber, "TAN-", true) OR
        STARTSWITH(c.cardNumber, "BF-", true) OR
        STARTSWITH(c.cardNumber, "NF-", true) OR
        STARTSWITH(c.cardNumber, "GOAT-", true)
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
  console.log(`\r  ${rows.length} baseball rows with insert-prefix cardNumber.        \n`);

  const patches = [];
  const dist = {};
  let noInsert = 0, alreadyCompound = 0, invalidSlug = 0;

  for (const r of rows) {
    const insertSlug = detectInsertSet(r.cardNumber);
    if (!insertSlug) { noInsert++; continue; }

    const parts = String(r.hobbyiqCardId ?? "").split(":");
    // Expected canonical slug shape: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N]
    if (parts.length < 7) { invalidSlug++; continue; }
    const oldSetKey = parts[3];
    if (!oldSetKey) { invalidSlug++; continue; }
    // Idempotent: if setKey already ends with the insert slug, skip.
    if (oldSetKey.endsWith(`-${insertSlug}`)) { alreadyCompound++; continue; }
    // Also skip if setKey already contains the insert slug fragment
    // (defensive against reorderings).
    if (oldSetKey.includes(insertSlug)) { alreadyCompound++; continue; }

    // Compose new setKey: `${old}-${insertSlug}`
    const newSetKey = `${oldSetKey}-${insertSlug}`;
    const newParts = parts.slice();
    newParts[3] = newSetKey;
    const newSlug = newParts.join(":");

    dist[newSetKey] = (dist[newSetKey] ?? 0) + 1;
    patches.push({ id: r.id, partitionKey: r.cardId, oldSlug: r.hobbyiqCardId, newSlug, cardNumber: r.cardNumber });
  }

  console.log(`  no insert:       ${noInsert}`);
  console.log(`  already compound:${alreadyCompound}`);
  console.log(`  invalid slug:    ${invalidSlug}`);
  console.log(`  Ready to patch:  ${patches.length}\n`);
  console.log(`  New setKey distribution (top 25):`);
  Object.entries(dist)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 25)
    .forEach(([k, c]) => console.log(`    ${String(c).padStart(6)}  ${k}`));

  if (patches.length > 0) {
    console.log(`\n  Sample 8:`);
    patches.slice(0, 8).forEach(p =>
      console.log(`    ${p.cardNumber.padEnd(10)}  ${p.oldSlug}\n                → ${p.newSlug}`)
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
