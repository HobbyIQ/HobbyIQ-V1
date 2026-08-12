// CF-FAST-PATCH-ID-IS-SLUG (Drew, 2026-08-08). For every catalog doc
// where `id` is ALREADY a canonical hiq: slug AND hobbyiqCardId is
// missing, PATCH hobbyiqCardId = id. No slug computation, no field
// resolution — the id itself IS the correct slug.
//
// From sampling: ~25% of the no-slug population (ch-catalog + seed
// source) fit this shape. That's ~700K docs recoverable with a trivial
// PATCH.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 do the writes
//   MAX_MINUTES                default 60
//   BATCH_SIZE                 default 500
//   CONCURRENCY                default 8 (low to coexist with audit)
//   THROTTLE_MS                default 50
const { CosmosClient, PartitionKeyBuilder } = require("@azure/cosmos");
const NONE_PK = new PartitionKeyBuilder().addNoneValue().build();

const APPLY       = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 60));
const BATCH_SIZE  = Math.max(50, Number(process.env.BATCH_SIZE || 500));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const THROTTLE_MS = Math.max(0, Number(process.env.THROTTLE_MS || 50));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[fast-patch] apply=${APPLY} maxMin=${MAX_MINUTES} conc=${CONCURRENCY} throttleMs=${THROTTLE_MS}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Filter: id starts with "hiq:" AND hobbyiqCardId is missing/empty.
  // ch-catalog docs match this and — importantly — are missing cardId,
  // so they live in the "None" Cosmos partition. Same shape as the
  // nuked sales-derived docs, PATCH via NONE_PK sentinel.
  const q = {
    query: `SELECT c.id, c.cardId FROM c
            WHERE STARTSWITH(c.id, 'hiq:')
              AND (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')`,
  };
  const iter = cat.items.query(q, { maxItemCount: BATCH_SIZE });

  let scanned = 0, patched = 0, errored = 0;
  const inflight = new Set();
  const errSamples = [];

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn(`[fast-patch] time cap`); break; }
    const { resources } = await iter.fetchNext();
    for (const r of resources) {
      scanned++;
      if (!APPLY) continue;
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // Use the row's cardId if present, otherwise the "None" PK sentinel.
      // Post-patch, doc stays in whatever partition it was in — moving
      // partitions requires delete+create, not worth it here since the
      // hobbyiqCardId field is what future joins use (indexed field
      // lookup, not partition-key lookup).
      const pk = r.cardId ? r.cardId : NONE_PK;
      const p = cat.item(r.id, pk).patch([
        { op: "add", path: "/hobbyiqCardId", value: r.id },
      ])
        .then(() => { patched++; })
        .catch((err) => {
          errored++;
          if (errSamples.length < 8) errSamples.push({ id: r.id, code: err?.code ?? err?.statusCode, msg: err?.message?.slice(0, 100) });
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (scanned % 20_000 === 0) {
      console.log(`  [progress] scanned=${scanned} patched=${patched} errored=${errored} inflight=${inflight.size}`);
    }
    if (THROTTLE_MS > 0) await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }

  while (inflight.size > 0) await Promise.race([...inflight]);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("\n=== FAST PATCH SUMMARY ===");
  console.log(`apply    : ${APPLY}`);
  console.log(`scanned  : ${scanned}`);
  console.log(`patched  : ${patched}`);
  console.log(`errored  : ${errored}`);
  console.log(`elapsed  : ${elapsed}s`);
  if (errSamples.length > 0) {
    console.log("Errors:");
    for (const e of errSamples) console.log(`  ${e.id?.slice(0, 40)}: code=${e.code} msg=${e.msg}`);
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
