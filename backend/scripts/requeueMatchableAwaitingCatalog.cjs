#!/usr/bin/env node
// CF-TARGETED-AWAITING-CATALOG-REQUEUE (Drew, 2026-08-14: "we need to really
// work on the ingestion and matching to catch up and stay ahead").
//
// The loop-back was open. A staged row lands in `awaiting-catalog` when its
// sale is real but no checklist describes the card, and recordSoldComp files a
// seed asking for that checklist. When the checklist finally lands, NOTHING
// wakes the rows that were waiting on it — requeueAwaitingCatalog.cjs is the
// only path back to `clean`, it is manual, and it appears in no workflow. So
// ingesting checklists did not convert into promoted sales; 283,157 rows were
// sitting on checklists, some of which had already arrived.
//
// This is the targeted version. The blunt one flips ALL awaiting-catalog rows
// back to `clean` regardless of whether their checklist arrived, so most churn
// through the expensive matcher, fail again, and land right back — costing a
// full promotion pass per row to learn nothing. Here we ask the catalog FIRST
// and requeue only slugs it can now actually resolve.
//
// Cheap because card_catalog stores id = cardId = hobbyiqCardId, so the
// existence check is a point read (1-2 RU), and it is done once per DISTINCT
// slug rather than once per row — the rows group heavily, since a set nobody
// has a checklist for produces many sales of the same few cards.
//
//   node scripts/requeueMatchableAwaitingCatalog.cjs
//   node scripts/requeueMatchableAwaitingCatalog.cjs --apply
//   node scripts/requeueMatchableAwaitingCatalog.cjs --max 50000   (sample+size)

const { CosmosClient } = require("@azure/cosmos");
const path = require("node:path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows the requeue loop took up (re-fetched per slug — not the
//              scan-time estimate, which can drift while a drain is running)
//   written  = patches acknowledged (requeued); failed = patches that threw
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
// Cap the SCAN, not the requeue. Useful to size the win without a full pass
// while a drain is running and competing for RU.
const MAX = Number(val("--max", "0")) || Infinity;
const PAGE = Number(val("--page", "1000"));
const CONCURRENCY = Number(val("--concurrency", "32"));
const TOP = Number(val("--top", "25"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const catalog = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER || "card_catalog");

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

(async () => {
  console.log(`targeted awaiting-catalog requeue — ${APPLY ? "APPLY" : "DRY RUN"}` +
    (MAX === Infinity ? "" : `  scan cap ${MAX.toLocaleString()}`) + "\n");

  // ---- 1. distinct slugs + row counts -------------------------------------
  // comps_staging partitions on /hobbyiqCardId, so grouping by it is
  // partition-aligned. Projecting the count here means we learn how many ROWS
  // each slug is worth without carrying every row id across the wire.
  const byCat = new Map();   // slug -> row count
  let scannedRows = 0;
  const t0 = Date.now();
  // CF-NO-GROUP-BY-AT-THIS-SCALE (2026-08-17). This was a server-side
  // `GROUP BY c.hobbyiqCardId`, and it died with "Maximum call stack size
  // exceeded" before printing a single count — the SDK's cross-partition
  // group-by aggregator recurses over the result set, and awaiting-catalog holds
  // ~896k rows across hundreds of thousands of distinct slugs.
  //
  // Nobody had seen this, because the job also failed on a missing
  // COSMOS_CONNECTION_STRING and exited 1 before reaching the query. Two
  // independent bugs stacked, so fixing the credential alone would have turned a
  // red run into a different red run.
  //
  // Stream the slugs and count them in JS instead — the same shape
  // checklist-gap-report uses over 9.7M rows without trouble. Flat memory per
  // page, no recursion, and the tally is identical.
  const iter = staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug
            FROM c
            WHERE c.status = 'awaiting-catalog'
              AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''`,
  }, { maxItemCount: PAGE });

  while (iter.hasMoreResults() && scannedRows < MAX) {
    const { resources } = await iter.fetchNext();
    // Cross-partition queries return empty pages while more results remain —
    // trust hasMoreResults(), not the page size.
    if (!resources || resources.length === 0) continue;
    for (const r of resources) {
      if (!r.slug) continue;
      byCat.set(r.slug, (byCat.get(r.slug) ?? 0) + 1);
      scannedRows++;
    }
  }
  const slugs = [...byCat.keys()];
  const totalRows = [...byCat.values()].reduce((a, b) => a + b, 0);
  console.log(`distinct slugs   : ${slugs.length.toLocaleString()}`);
  console.log(`rows they cover  : ${totalRows.toLocaleString()}`);
  console.log(`rows per slug    : ${(totalRows / Math.max(slugs.length, 1)).toFixed(1)}`);
  console.log(`scan took        : ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  if (!slugs.length) { console.log("nothing waiting."); return; }

  // ---- 2. which slugs does the catalog now resolve? ------------------------
  const resolvable = [];
  let checked = 0;
  await mapLimit(slugs, CONCURRENCY, async (slug) => {
    checked++;
    try {
      const { resource } = await catalog.item(slug, slug).read();
      if (resource) resolvable.push(slug);
    } catch { /* 404 = still no checklist for this card */ }
    if (checked % 5000 === 0) console.log(`   ...checked ${checked}/${slugs.length}, ${resolvable.length} resolvable`);
  });

  const rowsReady = resolvable.reduce((n, s) => n + (byCat.get(s) ?? 0), 0);
  const pct = (100 * rowsReady / Math.max(totalRows, 1)).toFixed(1);
  console.log(`\nslugs the catalog can NOW resolve : ${resolvable.length.toLocaleString()} / ${slugs.length.toLocaleString()}`);
  console.log(`rows that would promote           : ${rowsReady.toLocaleString()} (${pct}% of waiting)`);
  console.log(`rows still genuinely blocked      : ${(totalRows - rowsReady).toLocaleString()}\n`);

  // What is still missing, ranked by how many real sales are stuck on it —
  // this is the checklist work-list, ordered by market demand rather than guess.
  const blocked = slugs.filter((s) => !resolvable.includes(s));
  const bySet = new Map();
  for (const s of blocked) {
    // hiq:{vertical}:{year}:{setKey}:...
    const p = String(s).split(":");
    const key = p.length >= 4 ? `${p[1]}:${p[2]}:${p[3]}` : s;
    bySet.set(key, (bySet.get(key) ?? 0) + (byCat.get(s) ?? 0));
  }
  const ranked = [...bySet.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  console.log(`top ${ranked.length} MISSING checklists by stuck sales (vertical:year:setKey):`);
  for (const [k, n] of ranked) console.log(`  ${String(n).padStart(7)}  ${k}`);

  // ---- 3. requeue only the resolvable ones --------------------------------
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to requeue ${rowsReady.toLocaleString()} rows.`);
    return;
  }
  if (!resolvable.length) { console.log("\nnothing resolvable to requeue."); return; }

  console.log(`\nrequeueing ${rowsReady.toLocaleString()} rows across ${resolvable.length.toLocaleString()} slugs...`);
  let requeued = 0, errors = 0, attempted = 0;
  await mapLimit(resolvable, CONCURRENCY, async (slug) => {
    // Single-partition query: these rows all share hobbyiqCardId = slug.
    const { resources } = await staging.items.query({
      query: "SELECT c.id FROM c WHERE c.status = 'awaiting-catalog'",
      parameters: [],
    }, { partitionKey: slug }).fetchAll();
    for (const r of resources) {
      attempted++;
      try {
        // Patch, not replace — two fields instead of the whole document.
        await staging.item(r.id, slug).patch([
          { op: "set", path: "/status", value: "clean" },
          { op: "set", path: "/catalogRetryAt", value: new Date().toISOString() },
        ]);
        requeued++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error("  write error:", String(e && e.message).slice(0, 140));
      }
    }
  });

  console.log(`\nREQUEUED : ${requeued.toLocaleString()}`);
  console.log(`errors   : ${errors}`);
  reportWrites({ job: "requeueMatchableAwaitingCatalog", intended: attempted, written: requeued, failed: errors });
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
