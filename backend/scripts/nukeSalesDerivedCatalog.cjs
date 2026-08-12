// CF-CATALOG-NUKE-SALES-DERIVED (Drew, 2026-08-08, 8am authorization).
// Deletes card_catalog docs where source='sales-derived' AND no cardId
// field (i.e. legacy sha256-keyed docs that live in the Cosmos "None"
// partition because the old upsert never set cardId). These are the
// ~1.86M fragmentation docs the audit surfaced.
//
// Why safe to delete:
//   • sold_comps already carries the canonical hobbyiqCardId on 99.98%
//     of rows — no comp loses its join key.
//   • The correct catalog entry for each of these cards will be
//     recreated by the next ingest of that card via the post-42808c91
//     upsert (which keys on id=slug, cardId=slug, hobbyiqCardId=slug).
//   • Anything using catalog for search/pricing today reads
//     hobbyiqCardId — these docs don't have that field, so they weren't
//     even usable via the join.
//
// Behavior:
//   • Canary mode (DRY_RUN=true, default): scans + counts, no deletes.
//   • APPLY=true: executes deletes at bounded concurrency.
//   • Cosmos v4 SDK: uses PartitionKey.None for "no cardId" docs.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   COSMOS_DATABASE           default "hobbyiq"
//   APPLY=true                execute deletes (else dry-run count)
//   MAX_ROWS                  hard cap (default Infinity)
//   MAX_MINUTES               wall clock cap (default 240 = 4h)
//   BATCH_SIZE                page size (default 500)
//   CONCURRENCY               in-flight deletes (default 24)

const { CosmosClient, PartitionKeyBuilder } = require("@azure/cosmos");

// Cosmos v4 sentinel for "doc has no partition key field" (docs written
// without cardId land in this partition). Older code used
// PartitionKey.None; v4 exposes it via PartitionKeyBuilder.
const NONE_PK = new PartitionKeyBuilder().addNoneValue().build();

const APPLY       = process.env.APPLY === "true";
const MAX_ROWS    = Number(process.env.MAX_ROWS    || 0) || Infinity;
const MAX_MINUTES = Math.max(1,  Number(process.env.MAX_MINUTES || 240));
const BATCH_SIZE  = Math.max(50, Number(process.env.BATCH_SIZE  || 500));
const CONCURRENCY = Math.max(1,  Number(process.env.CONCURRENCY || 24));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[nuke-sales-derived] apply=${APPLY} cap=${MAX_ROWS === Infinity ? "unlimited" : MAX_ROWS} rows / ${MAX_MINUTES} min / batch=${BATCH_SIZE} conc=${CONCURRENCY}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Target: source='sales-derived' AND no cardId (the ~1.86M "None" partition docs)
  const q = {
    query: `SELECT c.id, c.source, c.cardId FROM c
            WHERE c.source = 'sales-derived'
              AND (NOT IS_DEFINED(c.cardId) OR c.cardId = null OR c.cardId = '')`,
  };
  const iter = cat.items.query(q, { maxItemCount: BATCH_SIZE });

  let scanned = 0, deleted = 0, errored = 0, notFound = 0;
  const inflight = new Set();
  const errSamples = [];

  while (iter.hasMoreResults()) {
    if (scanned >= MAX_ROWS)            { console.warn(`[nuke] row cap reached at ${scanned}`); break; }
    if (Date.now() - startMs > budgetMs) { console.warn(`[nuke] time cap reached at ${scanned}`); break; }

    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      if (!APPLY) continue;
      // Defensive: skip if somehow a cardId is present (shouldn't be, per WHERE)
      if (r.cardId) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);

      // These docs live in the "None" partition because cardId was never
      // set on write. NONE_PK is v4's sentinel (via PartitionKeyBuilder).
      const p = cat.item(r.id, NONE_PK).delete()
        .then(() => { deleted++; })
        .catch((err) => {
          const code = err?.code ?? err?.statusCode;
          if (code === 404) { notFound++; }
          else {
            errored++;
            if (errSamples.length < 8) errSamples.push({ id: r.id, code, msg: err?.message?.slice(0, 100) });
          }
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }

    if (scanned % 10_000 === 0) {
      console.log(`  [progress] scanned=${scanned} deleted=${deleted} notFound=${notFound} errored=${errored} inflight=${inflight.size}`);
    }
  }

  while (inflight.size > 0) await Promise.race([...inflight]);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("\n=== NUKE SUMMARY ===");
  console.log(`apply: ${APPLY}`);
  console.log(`scanned: ${scanned}`);
  console.log(`deleted: ${deleted}`);
  console.log(`notFound: ${notFound}`);
  console.log(`errored: ${errored}`);
  console.log(`elapsed: ${elapsed}s (${(deleted / Math.max(elapsed, 1)).toFixed(0)} deletes/s)`);
  if (errSamples.length > 0) {
    console.log("\nError samples:");
    for (const e of errSamples) console.log(`  ${e.id.slice(0, 40)}: code=${e.code} msg=${e.msg}`);
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
