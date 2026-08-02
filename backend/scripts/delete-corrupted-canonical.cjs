// CF-DELETE-CORRUPTED-CANONICAL (Drew, 2026-08-02). One-shot cleanup of
// the 337K corrupted canonical rows in card_catalog. These are dedupe
// artifacts from an earlier dedupe-catalog-by-hobbyiq run: bucketed
// into ambiguous "base-set" (and similar) setKey slugs, with all
// identifying fields (player, releaseName, cardNumber, parallels,
// attributes) dropped because they conflicted across the merged rows,
// while retaining a massive cross-player searchTokens mashup.
//
// Real underlying data is UNTOUCHED — the source='cardhedge' and
// source='cardsight' rows are all still present. This script only
// deletes rows where source='canonical' AND (player OR number OR
// releaseName is missing/undefined). That precisely targets the
// broken merge outputs and leaves any clean canonical rebuild
// intact.
//
// Env:
//   COSMOS_CONNECTION_STRING  (required)
//   APPLY=true                execute deletes (else dry-run count only)
//   CONCURRENCY=8             parallel delete workers
//   MAX_MINUTES=90            wall-clock cap
//
// Usage:
//   Dry-run:  node scripts/delete-corrupted-canonical.cjs
//   Live:     APPLY=true node scripts/delete-corrupted-canonical.cjs

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 90));

async function main() {
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(cs);
  const co = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  console.log(`[delete-corrupted-canonical] apply=${APPLY} concurrency=${CONCURRENCY} maxMinutes=${MAX_MINUTES}`);

  // Count first (both for the log and to sanity-check the filter)
  const countQ = `SELECT VALUE COUNT(1) FROM c
                  WHERE c.source = 'canonical'
                    AND (NOT IS_DEFINED(c.player) OR NOT IS_DEFINED(c.number) OR NOT IS_DEFINED(c.releaseName))`;
  const { resources: countRes } = await co.items.query(countQ).fetchAll();
  const targetCount = countRes[0];
  console.log(`corrupted canonical rows matching filter: ${targetCount}`);

  if (!APPLY) {
    console.log("DRY-RUN — no deletes performed. Re-run with APPLY=true to execute.");
    return;
  }

  if (targetCount === 0) {
    console.log("nothing to delete.");
    return;
  }

  // Stream and delete
  const iter = co.items.query({
    query: `SELECT c.id, c.cardId FROM c
            WHERE c.source = 'canonical'
              AND (NOT IS_DEFINED(c.player) OR NOT IS_DEFINED(c.number) OR NOT IS_DEFINED(c.releaseName))`,
  }, { maxItemCount: 500 });

  let deleted = 0, failed = 0;
  const inflight = new Set();

  async function deleteOne(row) {
    try {
      const partitionKey = row.cardId ?? row.id;
      await co.item(row.id, partitionKey).delete();
      deleted++;
      if (deleted % 5000 === 0) {
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
        const ratePerS = (deleted / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
        console.log(`  deleted=${deleted}/${targetCount} failed=${failed} elapsed=${elapsedS}s rate=${ratePerS}/s`);
      }
    } catch (err) {
      failed++;
      if (failed < 10) console.warn(`  delete failed: ${row.id} — ${err?.code ?? err?.message ?? err}`);
    }
  }

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) {
      console.warn(`[delete-corrupted-canonical] wall-clock cap ${MAX_MINUTES}m reached — stopping. Re-run to continue.`);
      break;
    }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      // Backpressure
      while (inflight.size >= CONCURRENCY) {
        await Promise.race([...inflight]);
      }
      const p = deleteOne(row).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  }
  await Promise.all([...inflight]);

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n[delete-corrupted-canonical] done — deleted=${deleted} failed=${failed} elapsed=${elapsedS}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
