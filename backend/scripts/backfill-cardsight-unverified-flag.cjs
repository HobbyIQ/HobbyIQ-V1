#!/usr/bin/env node
// CF-BACKFILL-CARDSIGHT-UNVERIFIED (Drew, 2026-08-01).
//
// The ingest path now auto-tags every new Cardsight-source row with
// __cardsightUnverified=true. This one-time backfill applies the
// same flag to the ~530K historical Cardsight rows so downstream
// filters can uniformly rely on the flag being present.
//
// SAFE: only writes __cardsightUnverified + __cardsightUnverifiedBackfillAt.
// Never touches slug, parallel, price, or any existing field.

const { CosmosClient } = require("@azure/cosmos");

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 12));

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
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[backfill-cardsight-unverified]  mode=${MODE}  concurrency=${CONCURRENCY}`);

  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE c.source = 'cardsight' AND (NOT IS_DEFINED(c.__cardsightUnverified) OR c.__cardsightUnverified != true)`
  }, { maxItemCount: 500 });

  let examined = 0, wouldChange = 0, errors = 0;
  const inFlight = [];
  const at = new Date().toISOString();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      wouldChange++;
      if (MODE === "apply") {
        row.__cardsightUnverified = true;
        row.__cardsightUnverifiedBackfillAt = at;
        inFlight.push(
          withRetry(() => sc.items.upsert(row)).catch(() => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 50000 === 0) console.log(`  examined=${examined}  wouldChange=${wouldChange}`);
  }
  await Promise.allSettled(inFlight);
  console.log(`\n=== Done ===  examined=${examined}  wouldChange=${wouldChange}  errors=${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
