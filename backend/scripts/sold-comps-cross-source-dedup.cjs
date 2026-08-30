// CF-CROSS-SOURCE-DEDUP (Drew, 2026-08-03). Same physical eBay
// sale often gets ingested from multiple vendors (CardHedge + TCA
// + Cardsight). The existing contentHash dedup is per-source, so
// cross-source duplicates slip through.
//
// This script identifies + deletes those cross-source dupes.
// Match key: (title-hash, price, soldAt-day) — three sources
// listing the same sale on the same day for the same price with
// the same title text = same real sale.
//
// Keep the earliest observedAt (first ingest wins). Delete the rest.
//
// Idempotent — re-runs are safe (dupes only exist once).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 delete (else dry-run count of duplicate groups)
//   MAX_MINUTES=50             wall-clock cap
//   BATCH=1000                 rows per Cosmos query page
//   MIN_PRICE=1                skip rows with price < this (avoid noise)

const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). This deletes. Counters,
// disjoint: intended = non-survivor rows the loop took up; written = deletes
// acknowledged; skipped = already gone (404); failed = deletes that threw.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 50));
const BATCH = Math.max(200, Number(process.env.BATCH || 1000));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const MIN_PRICE = Math.max(0, Number(process.env.MIN_PRICE || 1));

function titleHash(t) {
  return crypto.createHash("sha256").update(String(t ?? "").toLowerCase().trim()).digest("hex").slice(0, 16);
}

function groupKey(row) {
  const day = String(row.soldAt ?? "").slice(0, 10);
  const price = typeof row.price === "number" ? row.price.toFixed(2) : String(row.price);
  return `${titleHash(row.title)}|${price}|${day}`;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const cosmos = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sold = cosmos.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[xsrc-dedup] apply=${APPLY} maxMin=${MAX_MINUTES} batch=${BATCH} concurrency=${CONCURRENCY} minPrice=${MIN_PRICE}`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Phase 1: scan all rows, build grouping index
  const q = {
    query: `SELECT c.id, c.cardId, c.title, c.price, c.soldAt, c.source, c.observedAt FROM c WHERE IS_DEFINED(c.title) AND c.price >= @minp`,
    parameters: [{ name: "@minp", value: MIN_PRICE }],
  };
  const iter = sold.items.query(q, { maxItemCount: BATCH });
  const groups = new Map();  // key -> [{id, cardId, source, observedAt}, ...]
  let scanned = 0;

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap during scan"); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      if (!row.title || !row.soldAt || !(row.price >= MIN_PRICE)) continue;
      const key = groupKey(row);
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push({ id: row.id, cardId: row.cardId, source: row.source, observedAt: row.observedAt });
    }
    if (scanned % 100000 === 0) {
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  scan: rows=${scanned.toLocaleString()} groups=${groups.size.toLocaleString()} el=${el}s`);
    }
  }

  // Phase 2: find duplicate groups (size > 1), delete all except earliest observedAt
  let dupeGroups = 0, dupeRows = 0, deleted = 0, gone = 0, errors = 0, attempted = 0;
  const sourcesCrossed = new Map(); // count how many cross-source combos
  const inflight = new Set();

  for (const [key, arr] of groups.entries()) {
    if (arr.length < 2) continue;
    // Only count as cross-source if there are multiple distinct sources
    const distinctSources = new Set(arr.map(r => r.source));
    if (distinctSources.size < 2) continue;
    dupeGroups++;
    dupeRows += arr.length;
    const combo = [...distinctSources].sort().join("+");
    sourcesCrossed.set(combo, (sourcesCrossed.get(combo) || 0) + 1);
    // Keep earliest observedAt; delete others
    arr.sort((a, b) => String(a.observedAt || "").localeCompare(String(b.observedAt || "")));
    const survivor = arr[0];
    const toDelete = arr.slice(1);
    if (!APPLY) continue;
    for (const row of toDelete) {
      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      attempted++;
      const p = sold.item(row.id, row.cardId).delete()
        .then(() => { deleted++; })
        .catch((err) => {
          if (err?.code === 404) { gone++; return; }
          errors++;
          if (errors < 10) console.warn(`  delete err id=${row.id}: ${err?.code ?? err?.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    void survivor;
    if (dupeGroups % 10000 === 0) {
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  dedup: groups=${dupeGroups.toLocaleString()} deleted=${deleted.toLocaleString()} errors=${errors} el=${el}s`);
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[xsrc-dedup] DONE — scanned=${scanned.toLocaleString()} groups=${groups.size.toLocaleString()} dupeGroups=${dupeGroups.toLocaleString()} dupeRows=${dupeRows.toLocaleString()} deleted=${deleted.toLocaleString()} gone=${gone.toLocaleString()} errors=${errors} el=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  console.log("Cross-source combos:");
  for (const [combo, n] of [...sourcesCrossed.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${combo.padEnd(35)} ${n.toLocaleString()}`);
  }
  if (!APPLY) console.log("(dry-run — no deletes)");
  if (APPLY) reportWrites({ job: "sold-comps-cross-source-dedup", intended: attempted, written: deleted, skipped: gone, failed: errors });
}

main().catch((err) => { console.error(err); process.exit(1); });
