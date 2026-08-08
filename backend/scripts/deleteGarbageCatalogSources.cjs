// CF-DELETE-GARBAGE-CATALOG (Drew, 2026-08-08). One-shot cleanup:
// delete card_catalog rows from the two known-garbage sources that
// were bulk-built from polluted sold_comps rows years ago:
//   - source='sales-derived'   (bad eBay title parsing → playerName leaks)
//   - source='tree-builder-v1' (built from same polluted pool)
//
// Clean sources retained: tcdb-scrape, bulk-build-from-pool,
// bccp-product-structure, clc-product-structure, cardhedge,
// cardsight, and any others.
//
// Reversible only via re-run of the source builders. If we ever want
// tree-builder-v1 back, the sold_comps pool must be re-cleaned first
// (holdingFieldNormalizer needs the subset-descriptor fix per
// CF-NORMALIZER-SUBSET-STRIP backlog).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 do the deletes (else dry-run: count + sample)
//   BATCH_SIZE                 rows per query page (default 200)
//   MAX_ROWS                   total cap per run (default 500000)
//   CONCURRENCY                parallel deletes per batch (default 16)

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const MAX_ROWS = Number(process.env.MAX_ROWS || 500000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const GARBAGE_SOURCES = ["sales-derived", "tree-builder-v1"];

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const cat = c.database("hobbyiq").container("card_catalog");
  console.log(`[delete-garbage] apply=${APPLY}  sources=${JSON.stringify(GARBAGE_SOURCES)}  batch=${BATCH_SIZE}  max=${MAX_ROWS}  conc=${CONCURRENCY}`);

  // Sample first — show what's about to be deleted
  console.log("\nSample of rows to delete:");
  for (const src of GARBAGE_SOURCES) {
    const { resources } = await cat.items.query({
      query: `SELECT TOP 3 c.id, c.playerName, c.player, c.setName, c.cardNumber, c.year FROM c WHERE c.source = @src`,
      parameters: [{ name: "@src", value: src }],
    }, { maxItemCount: 3 }).fetchNext();
    console.log(`  --- source='${src}' ---`);
    if (resources.length === 0) console.log("    (none)");
    for (const r of resources) {
      const name = r.playerName || r.player || "?";
      console.log(`    id=${(r.id || "").slice(0, 55).padEnd(55)}  ${r.year}  ${r.setName || "?"} #${r.cardNumber || "?"}  '${name}'`);
    }
  }

  let totalSeen = 0, totalDeleted = 0, totalErrored = 0;
  const startMs = Date.now();

  // Paginate with continuation tokens (resume-safe on crash)
  for (const src of GARBAGE_SOURCES) {
    console.log(`\n=== Draining source='${src}' ===`);
    let continuation = undefined;
    let iterations = 0;
    while (totalSeen < MAX_ROWS) {
      iterations++;
      const iterator = cat.items.query({
        query: `SELECT c.id, c.cardId FROM c WHERE c.source = @src`,
        parameters: [{ name: "@src", value: src }],
      }, { maxItemCount: BATCH_SIZE, continuationToken: continuation });
      let resources, continuationToken;
      try {
        const result = await iterator.fetchNext();
        resources = result.resources;
        continuationToken = result.continuationToken;
      } catch (err) {
        if (err?.code === 429) {
          const wait = Number(err?.retryAfterInMs ?? 5000);
          console.log(`  429 fetch — backing off ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
      if (!resources || resources.length === 0) break;
      totalSeen += resources.length;

      if (!APPLY) {
        console.log(`  page ${iterations}: seen ${resources.length} rows (dry-run — no deletes)`);
        if (!continuationToken) break;
        continuation = continuationToken;
        continue;
      }

      // Delete with bounded concurrency + 429 retry
      let pageDeleted = 0, pageErr = 0;
      for (let i = 0; i < resources.length; i += CONCURRENCY) {
        const chunk = resources.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(async (r) => {
          const pk = r.cardId || r.id;
          for (let a = 0; a < 5; a++) {
            try {
              await cat.item(r.id, pk).delete();
              return;
            } catch (err) {
              const code = err?.code ?? err?.statusCode;
              if (code === 429 && a < 4) {
                const wait = Number(err?.retryAfterInMs ?? (200 * Math.pow(2, a)));
                await new Promise(res => setTimeout(res, wait));
                continue;
              }
              if (code === 404) return; // already gone, count as success
              throw err;
            }
          }
        }));
        for (const rr of results) {
          if (rr.status === "fulfilled") pageDeleted++;
          else { pageErr++; if (totalErrored + pageErr <= 3) console.warn(`  delete err: ${rr.reason?.message?.slice(0, 120)}`); }
        }
      }
      totalDeleted += pageDeleted;
      totalErrored += pageErr;
      const rate = totalDeleted / Math.max(1, (Date.now() - startMs) / 1000);
      console.log(`  page ${iterations}: deleted ${pageDeleted}/${resources.length} (running total: deleted=${totalDeleted} err=${totalErrored} rate=${rate.toFixed(0)}/s)`);
      if (!continuationToken) break;
      continuation = continuationToken;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  apply:   ${APPLY}`);
  console.log(`  seen:    ${totalSeen.toLocaleString()}`);
  console.log(`  deleted: ${totalDeleted.toLocaleString()}`);
  console.log(`  errored: ${totalErrored.toLocaleString()}`);
  console.log(`  elapsed: ${Math.round((Date.now() - startMs) / 1000)}s`);
  if (!APPLY) console.log(`\n  [dry-run] no deletes. Rerun with APPLY=true.`);
}

main().catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
