// CF-PURGE-OLD-SALES-DERIVED (Drew, 2026-08-03). Deletes card_catalog
// rows written by the pre-consolidation synth run. After the new
// synth completes with normalizeSetKey active, this script cleans
// up the old un-normalized rows so we're left with a single clean
// set-key set.
//
// Identifies "old" rows by synthesizedAt cutoff: anything written
// before CUTOFF_ISO is deleted. Default cutoff is passed via env.
// Idempotent — running twice is a no-op after the first pass.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   CUTOFF_ISO                 delete rows with synthesizedAt < this (ISO 8601)
//   APPLY=true                 execute deletes (else dry-run count)
//   MAX_MINUTES=50             wall-clock cap
//   CONCURRENCY=32             parallel deletes

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). Counters, disjoint:
//   intended = rows scanned under APPLY (every scanned row gets a delete)
//   written  = deletes acknowledged; skipped = already gone (404, idempotent)
//   failed   = deletes that threw otherwise
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.APPLY === "true";
const CUTOFF_ISO = process.env.CUTOFF_ISO;
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 50));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  if (!CUTOFF_ISO) { console.error("CUTOFF_ISO required (ISO timestamp; rows synthesized before this get deleted)"); process.exit(1); }
  const cosmos = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cat = cosmos.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[purge] apply=${APPLY} cutoff=${CUTOFF_ISO} maxMin=${MAX_MINUTES} concurrency=${CONCURRENCY}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  const q = {
    query: "SELECT c.id, c.synthesizedAt FROM c WHERE c.source = 'sales-derived' AND c.synthesizedAt < @cutoff",
    parameters: [{ name: "@cutoff", value: CUTOFF_ISO }],
  };
  const iter = cat.items.query(q, { maxItemCount: 500 });

  let scanned = 0, deleted = 0, gone = 0, errors = 0;
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap"); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      if (!APPLY) continue;
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      const p = cat.item(row.id, row.id).delete()
        .then(() => { deleted++; })
        .catch((err) => {
          if (err?.code === 404) { gone++; return; }   // already gone — idempotent
          errors++;
          if (errors < 10) console.warn(`  delete err id=${row.id}: ${err?.code ?? err?.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
      if (scanned % 5000 === 0) {
        const el = ((Date.now() - startMs) / 1000).toFixed(0);
        const rate = (scanned / Math.max(1, (Date.now() - startMs) / 1000)).toFixed(1);
        console.log(`  scanned=${scanned.toLocaleString()} deleted=${deleted.toLocaleString()} errors=${errors} rate=${rate}/s el=${el}s`);
      }
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[purge] DONE — scanned=${scanned.toLocaleString()} deleted=${deleted.toLocaleString()} gone=${gone.toLocaleString()} errors=${errors} elapsed=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  if (!APPLY) console.log("(dry-run — no deletes)");
  if (APPLY) reportWrites({ job: "purge-old-sales-derived", intended: scanned, written: deleted, skipped: gone, failed: errors });
}

main().catch((err) => { console.error(err); process.exit(1); });
