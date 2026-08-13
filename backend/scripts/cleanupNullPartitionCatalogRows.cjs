#!/usr/bin/env node
// CF-CATALOG-CARDID-PARTITION-CLEANUP (Drew, 2026-08-13: "lets fix them").
//
// Companion to CF-CATALOG-CARDID-PARTITION-KEY. card_catalog partitions on
// /cardId, but deriveCatalogEntry used to emit entries with NO cardId — its
// interface comment claimed the partition key was `sport` — so every row the
// checklist ingest wrote landed in the UNDEFINED partition. Cosmos allows the
// same `id` in a different partition, so each ingest created a SECOND document
// beside the canonical one instead of updating it, and both reported success.
//
// Addressing (verified against prod 2026-08-13):
//     container.item(id, id)        -> the canonical row      (cardId set)
//     container.item(id, undefined) -> the stranded duplicate (cardId absent)
//     container.item(id, null)      -> not found
//
// SAFETY RULE, and it is the whole point: a stranded row is DELETED only when a
// correctly-partitioned twin exists, because then it is a pure duplicate. A row
// that lives ONLY in the undefined partition is real catalog data no point read
// can reach, so it is PROMOTED instead — rewritten with cardId set, verified,
// and only then removed from the undefined partition.
//
// Both halves are load-bearing. A 60-row sample suggested this was a pure
// de-dup: 58 identical twins, 2 differing only in punctuation ("Jose Cruz Jr."
// vs "Jose Cruz, Jr."), none without a twin. That sample happened to land
// entirely in one set. A full scan found ~23% of stranded rows have NO twin, so
// a delete-only pass would have destroyed thousands of cards that exist nowhere
// else.
//
// Scoped to canonical `hiq:` slugs. Rows like `ebay-browse:<hash>` and
// `user-verified:<hash>` also sit in the undefined partition but are a
// different row type that may legitimately have no cardId — out of scope.
//
// Dry-run by default. Pass --apply to write. --no-promote to only de-dup.
//
//   node scripts/cleanupNullPartitionCatalogRows.cjs
//   node scripts/cleanupNullPartitionCatalogRows.cjs --apply

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MAX = Number(val("--max", "1000000"));
const PROMOTE = !args.includes("--no-promote");
const CONCURRENCY = Number(val("--concurrency", "16"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const cat = new CosmosClient(cn)
  .database(process.env.COSMOS_DATABASE || "hobbyiq")
  .container("card_catalog");

async function withRetry(fn, attempt = 0) {
  try { return await fn(); }
  catch (e) {
    if (e.code === 404) return null;
    if (attempt < 4 && (e.code === 429 || e.code === 503 || e.code === "ECONNRESET")) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      return withRetry(fn, attempt + 1);
    }
    throw e;
  }
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

const stats = { seen: 0, deleted: 0, wouldDelete: 0, noTwin: 0, promoted: 0, wouldPromote: 0, conflicting: 0, errors: 0 };
const noTwinSamples = [];
const conflictSamples = [];

async function handle(row) {
  stats.seen++;
  let twin;
  try {
    const r = await withRetry(() => cat.item(row.id, row.id).read());
    twin = r && r.resource;
  } catch { stats.errors++; return; }

  if (!twin) {
    // Data exists ONLY in the undefined partition — deleting would lose the
    // card. These are real catalog rows that no point read can reach, so they
    // get PROMOTED: rewritten with cardId set, then the stranded copy removed.
    // A first pass assumed these barely existed; a full scan found ~23% of
    // stranded rows have no twin, which makes promotion the more valuable half
    // of this cleanup rather than an edge case.
    stats.noTwin++;
    if (noTwinSamples.length < 10) noTwinSamples.push(`${row.id}  ${row.playerName ?? "?"}`);
    if (!PROMOTE) return;

    try {
      // Read the full stranded doc — the scan query selected only 3 fields.
      const full = await withRetry(() => cat.item(row.id, undefined).read());
      const doc = full && full.resource;
      if (!doc) { stats.errors++; return; }

      const next = { ...doc, cardId: doc.id, hobbyiqCardId: doc.id };
      delete next._rid; delete next._self; delete next._etag;
      delete next._attachments; delete next._ts;

      if (!APPLY) { stats.wouldPromote++; return; }

      // Write the reachable copy FIRST and verify it, then remove the stranded
      // one. A crash mid-promote leaves a duplicate (recoverable by this same
      // script) rather than losing the card.
      await withRetry(() => cat.items.upsert(next));
      const check = await withRetry(() => cat.item(doc.id, doc.id).read());
      if (!check || !check.resource) { stats.errors++; return; }
      await withRetry(() => cat.item(row.id, undefined).delete());
      stats.promoted++;
    } catch { stats.errors++; }
    return;
  }

  if (String(twin.playerName ?? "") !== String(row.playerName ?? "")) {
    stats.conflicting++;
    if (conflictSamples.length < 10) {
      conflictSamples.push(`${row.id}\n      stranded="${row.playerName}"  canonical="${twin.playerName}"`);
    }
    // Still a duplicate of the same card id; the canonical row wins. Deleting
    // the stranded copy is still correct — we are not choosing a name here,
    // just removing a row that no point read could ever reach.
  }

  stats.wouldDelete++;
  if (!APPLY) return;
  try {
    await withRetry(() => cat.item(row.id, undefined).delete());
    stats.deleted++;
  } catch { stats.errors++; }
}

(async () => {
  console.log(`null-partition catalog cleanup — ${APPLY ? "APPLY (deletes)" : "DRY RUN"}\n`);
  const iter = cat.items.query({
    query: "SELECT c.id, c.playerName, c.source FROM c WHERE NOT IS_DEFINED(c.cardId) AND STARTSWITH(c.id, 'hiq:')",
  }, { maxItemCount: 500 });

  let batch = 0;
  while (iter.hasMoreResults() && stats.seen < MAX) {
    const { resources } = await withRetry(() => iter.fetchNext());
    // A cross-partition query routinely returns EMPTY pages while more results
    // remain — each physical partition is drained in turn. Breaking on the
    // first empty page reported "0 stranded rows" against a container that had
    // just returned 300 for the same predicate. Trust hasMoreResults(), not the
    // page size.
    if (!resources || resources.length === 0) continue;
    await mapLimit(resources, CONCURRENCY, handle);
    batch++;
    if (batch % 4 === 0) {
      console.log(`  ...${stats.seen} scanned, ${APPLY ? stats.deleted + " deleted" : stats.wouldDelete + " would delete"}, ${stats.noTwin} kept (no twin)`);
    }
  }

  console.log(`\nstranded canonical rows scanned : ${stats.seen}`);
  console.log(`  ${APPLY ? "DELETED (had a twin)        " : "would delete (has a twin)   "}: ${APPLY ? stats.deleted : stats.wouldDelete}`);
  console.log(`  of those, name conflicted     : ${stats.conflicting}  (canonical row wins)`);
console.log(`  no twin (unreachable rows)    : ${stats.noTwin}`);
  console.log(`    ${APPLY ? "PROMOTED to their partition" : "would promote"}   : ${APPLY ? stats.promoted : stats.wouldPromote}${PROMOTE ? "" : "  (promotion disabled)"}`);
  console.log(`  errors                        : ${stats.errors}`);

  if (conflictSamples.length) {
    console.log("\nname conflicts (canonical kept):");
    for (const s of conflictSamples) console.log("   " + s);
  }
  if (noTwinSamples.length) {
    console.log("\nexamples of rows that existed ONLY in the undefined partition:");
    for (const s of noTwinSamples) console.log("   " + s);
  }
  if (!APPLY) console.log("\nDRY RUN — nothing deleted. Re-run with --apply.");
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
