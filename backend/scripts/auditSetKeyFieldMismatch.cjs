// CF-AUDIT-SETKEY-FIELD-MISMATCH (Drew, 2026-08-11). Historical ingest
// bug (fixed in ingest-hand-fetched-checklists.cjs + ingest-scraped-
// checklist.cjs earlier today) stored the raw display setName in the
// setKey field of card_catalog rows — e.g. setKey="2024-25 Panini
// Prizm" instead of the canonical "panini-prizm". The hobbyiqCardId
// slug itself is correct (slug generator canonicalizes internally),
// but WHERE c.setKey='panini-prizm' filters miss these rows.
//
// This script: scan card_catalog for rows where the stored setKey
// disagrees with the setKey embedded in position 3 of hobbyiqCardId.
// When they disagree, the slug is authoritative — patch the setKey
// field to match.
//
// Env: APPLY=true (default dry-run), CONCURRENCY=8, MAX_ROWS=0, SHARD_TOTAL=0 SHARD_INDEX=0

const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const MAX_ROWS = Number(process.env.MAX_ROWS || 0);
const SHARD_TOTAL = Number(process.env.SHARD_TOTAL || 0);
const SHARD_INDEX = Number(process.env.SHARD_INDEX || 0);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  shard=${SHARD_TOTAL ? `${SHARD_INDEX}/${SHARD_TOTAL}` : "off"}`);

  const clauses = [
    "IS_STRING(c.hobbyiqCardId)",
    "STARTSWITH(c.hobbyiqCardId, 'hiq:')",
    "IS_DEFINED(c.setKey)",
  ];
  if (SHARD_TOTAL > 0) clauses.push(`(c.cardYear % ${SHARD_TOTAL}) = ${SHARD_INDEX}`);
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setKey FROM c WHERE ${clauses.join(" AND ")}`;
  const iter = c.items.query({ query: q }, { maxItemCount: 500 });

  async function fetchWithRetry(tries = 15) {
    for (let i = 0; i < tries; i++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) { await new Promise(r => setTimeout(r, (err.retryAfterInMs || 2000 * (i+1)) + 500)); continue; }
        throw err;
      }
    }
    throw new Error("fetchNext exhausted");
  }

  async function patchWithRetry(r, canonicalSetKey, tries = 5) {
    for (let i = 0; i < tries; i++) {
      try {
        await c.item(r.id, r.cardId).patch([
          { op: "set", path: "/setKey", value: canonicalSetKey },
          { op: "set", path: "/setKeyRepairedAt", value: new Date().toISOString() },
          { op: "set", path: "/setKeyRepairedFrom", value: r.setKey },
        ]);
        return true;
      } catch (err) {
        if (err && err.code === 429) { await new Promise(r => setTimeout(r, (err.retryAfterInMs || 500 * (i+1)) + 100)); continue; }
        throw err;
      }
    }
    return false;
  }

  let scanned = 0, mismatched = 0, patched = 0, failed = 0;
  const inflight = [];
  const t0 = Date.now();
  const rewritePatterns = new Map();

  while (iter.hasMoreResults()) {
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
    const { resources } = await fetchWithRetry();
    for (const r of resources) {
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
      scanned++;
      const parts = String(r.hobbyiqCardId).split(":");
      if (parts.length < 4) continue;
      const canonical = parts[3];
      if (!canonical || canonical === r.setKey) continue;
      mismatched++;
      const key = `${r.setKey} -> ${canonical}`;
      rewritePatterns.set(key, (rewritePatterns.get(key) || 0) + 1);
      if (!APPLY) continue;
      const task = patchWithRetry(r, canonical)
        .then(ok => { if (ok) patched++; else failed++; })
        .catch(e => { failed++; if (failed < 5) console.warn(`  fail ${r.id}: ${e.message}`); })
        .finally(() => { const i = inflight.indexOf(task); if (i >= 0) inflight.splice(i, 1); });
      inflight.push(task);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);
      if (scanned % 5000 === 0) {
        const dur = ((Date.now()-t0)/1000).toFixed(0);
        console.log(`  scanned=${scanned.toLocaleString()} mismatched=${mismatched.toLocaleString()} patched=${patched.toLocaleString()} failed=${failed}  ${dur}s`);
      }
    }
  }
  await Promise.all(inflight);
  const dur = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`\n[done ${dur}s]`);
  console.log(`  scanned:    ${scanned.toLocaleString()}`);
  console.log(`  mismatched: ${mismatched.toLocaleString()}`);
  console.log(`  patched:    ${patched.toLocaleString()}`);
  console.log(`  failed:     ${failed}`);
  console.log(`\ntop rewrite patterns:`);
  const top = [...rewritePatterns.entries()].sort((a,b) => b[1] - a[1]).slice(0, 20);
  for (const [k, v] of top) console.log(`  ${v.toString().padStart(6)}  ${k}`);
}
main().catch(e => { console.error(e); process.exit(1); });
