// One-shot: delete the 12998 tca-ebay sold_comps rows that were
// written by the pre-refactor ingest (before persistVendorSalesToPool
// routing). They lack hobbyiqCardId, contentHash, and staging
// provenance. Safe: no other rows have source='tca-ebay' yet, and
// crawl_state is reset to allow re-ingest from cursor=null.
//
// Env: COSMOS_CONNECTION_STRING required. APPLY=true to execute.

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sold = db.container("sold_comps");
  const state = db.container("crawl_state");

  // Count first
  const { resources: countRes } = await sold.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'tca-ebay'",
  }).fetchAll();
  const n = countRes[0];
  console.log(`tca-ebay rows in sold_comps: ${n}`);
  if (!APPLY) { console.log("DRY-RUN — set APPLY=true to delete."); return; }

  if (n === 0) { console.log("nothing to delete."); return; }

  // Stream + delete
  const iter = sold.items.query({
    query: "SELECT c.id, c.cardId FROM c WHERE c.source = 'tca-ebay'",
  }, { maxItemCount: 500 });

  let deleted = 0; let failed = 0;
  const inflight = new Set();
  const CONCURRENCY = 4;   // conservative — Cosmos throttled at 8 earlier

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const p = sold.item(row.id, row.cardId).delete()
        .then(() => { deleted++; })
        .catch((err) => {
          failed++;
          if (failed < 10) console.warn(`  delete failed id=${row.id}: ${err?.code ?? err?.message ?? err}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
      if ((deleted + failed) % 2000 === 0 && (deleted + failed) > 0) {
        console.log(`  deleted=${deleted}/${n} failed=${failed}`);
      }
    }
  }
  await Promise.all([...inflight]);

  // Reset crawl_state so the re-ingest starts from a clean cursor
  console.log(`\nresetting crawl_state cursor…`);
  try {
    const iter2 = state.items.query({ query: "SELECT c.id FROM c WHERE STARTSWITH(c.id, 'tca-')" }).getAsyncIterator();
    for await (const page of iter2) {
      for (const s of page.resources) {
        await state.item(s.id, s.id).delete();
        console.log(`  deleted crawl_state doc: ${s.id}`);
      }
    }
  } catch (e) { console.warn("  crawl_state reset warning:", e.message); }

  console.log(`\ndone — deleted=${deleted} failed=${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
