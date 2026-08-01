#!/usr/bin/env node
// CF-MIGRATE-CARDSIGHT-TO-STAGING (Drew, 2026-08-01).
//
// One-time migration of existing Cardsight sold_comps rows to a new
// cardsight_staging container. After this, sold_comps == confirmed-
// sold-only (cardhedge, ebay-*, manual-user-entry).
//
// Process:
//   1. Reads each Cardsight-source row from sold_comps.
//   2. Upserts a copy to cardsight_staging.
//   3. If MIGRATION_DELETE_SOURCE=true, deletes the row from sold_comps.
//      (Off by default — leaves the source rows in place until we've
//       verified the migration.)
//
// Env:
//   COSMOS_CONNECTION_STRING       required
//   BACKFILL_APPLY / BACKFILL_MODE   apply | dry (default dry)
//   MIGRATION_DELETE_SOURCE        true | false (default false)
//   BACKFILL_CONCURRENCY           default 12

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")).toLowerCase();
const DELETE_SOURCE = process.env.MIGRATION_DELETE_SOURCE === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));
const STAGING_CONTAINER = process.env.COSMOS_CARDSIGHT_STAGING_CONTAINER || "cardsight_staging";

async function withRetry(fn, attempts = 5, baseMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const is429 = e?.code === 429 || e?.statusCode === 429;
      if (!is429 || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const sc = db.container("sold_comps");
  const { container: staging } = await db.containers.createIfNotExists({
    id: STAGING_CONTAINER,
    partitionKey: { paths: ["/cardId"] },
    defaultTtl: -1,
  });

  console.log(`[migrate-cardsight-to-staging]  mode=${MODE}  deleteSource=${DELETE_SOURCE}  concurrency=${CONCURRENCY}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE c.source = 'cardsight'`
  }, { maxItemCount: 500 });

  let examined = 0, copied = 0, deleted = 0, errors = 0;
  const inFlight = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      if (MODE !== "apply") { copied++; continue; }

      // Copy to staging container. Preserve id + cardId.
      const p = withRetry(() => staging.items.upsert(row))
        .then(async () => {
          copied++;
          if (DELETE_SOURCE) {
            try {
              await sc.item(row.id, row.cardId).delete();
              deleted++;
            } catch { errors++; }
          }
        })
        .catch(() => { errors++; });
      inFlight.push(p);
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
    }
    if (examined % 50000 === 0) console.log(`  examined=${examined}  copied=${copied}  deleted=${deleted}  errors=${errors}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===`);
  console.log(`  examined:  ${examined}`);
  console.log(`  copied to staging: ${copied}`);
  console.log(`  deleted from sold_comps: ${deleted} (delete-source=${DELETE_SOURCE})`);
  console.log(`  errors:    ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
