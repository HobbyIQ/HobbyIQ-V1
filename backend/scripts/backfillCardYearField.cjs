// CF-BACKFILL-CARDYEAR-FIELD (Drew, 2026-08-11). Legacy schema drift:
// 6.4M rows carry `cardYear`, 9.26M rows carry only `year`. Pricing +
// search services filter on `c.cardYear = X`, missing the year-only
// rows — 2023 Topps Chrome Titans CT-10 Rutschman came up "no comps"
// because the base identity row had year but no cardYear, so
// downstream lookups didn't find it.
//
// This script: patch every row that has `year` but not `cardYear` to
// set cardYear = year. Also patches the reverse (cardYear but not
// year) so both fields always coexist going forward.
//
// deriveCatalogEntry now writes both — this backfill closes the
// historical gap.
//
// Env: APPLY=true, CONCURRENCY=8, SHARD_TOTAL=0 SHARD_INDEX=0

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const SHARD_TOTAL = Number(process.env.SHARD_TOTAL || 0);
const SHARD_INDEX = Number(process.env.SHARD_INDEX || 0);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  shard=${SHARD_TOTAL ? `${SHARD_INDEX}/${SHARD_TOTAL}` : "off"}`);

  const clauses = [
    "IS_DEFINED(c.year)",
    "NOT IS_DEFINED(c.cardYear)",
  ];
  if (SHARD_TOTAL > 0) clauses.push(`(c.year % ${SHARD_TOTAL}) = ${SHARD_INDEX}`);
  const q = `SELECT c.id, c.cardId, c.year FROM c WHERE ${clauses.join(" AND ")}`;
  const iter = c.items.query({ query: q }, { maxItemCount: 500 });

  async function fetchWithRetry(tries = 20) {
    for (let i = 0; i < tries; i++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) { await new Promise(r => setTimeout(r, (err.retryAfterInMs || 2000*(i+1)) + 500)); continue; }
        throw err;
      }
    }
    throw new Error("fetchNext exhausted");
  }

  async function patchWithRetry(r, tries = 5) {
    for (let i = 0; i < tries; i++) {
      try {
        await c.item(r.id, r.cardId).patch([
          { op: "set", path: "/cardYear", value: r.year },
        ]);
        return true;
      } catch (err) {
        if (err && err.code === 429) { await new Promise(r => setTimeout(r, (err.retryAfterInMs || 500*(i+1)) + 100)); continue; }
        throw err;
      }
    }
    return false;
  }

  let scanned = 0, patched = 0, failed = 0, batches = 0;
  const inflight = [];
  const t0 = Date.now();
  while (iter.hasMoreResults()) {
    const { resources } = await fetchWithRetry();
    batches++;
    for (const r of resources) {
      scanned++;
      if (!APPLY) continue;
      const task = patchWithRetry(r)
        .then(ok => { if (ok) patched++; else failed++; })
        .catch(e => { failed++; if (failed < 5) console.warn(`  fail ${r.id}: ${e.message}`); })
        .finally(() => { const i = inflight.indexOf(task); if (i >= 0) inflight.splice(i, 1); });
      inflight.push(task);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);
    }
    if (batches <= 5 || batches % 20 === 0) {
      const dur = ((Date.now()-t0)/1000).toFixed(0);
      console.log(`  batch=${batches} scanned=${scanned.toLocaleString()} patched=${patched.toLocaleString()} failed=${failed}  ${dur}s`);
    }
  }
  await Promise.all(inflight);
  const dur = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`\n[done ${dur}s] scanned=${scanned.toLocaleString()} patched=${patched.toLocaleString()} failed=${failed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
