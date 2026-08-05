#!/usr/bin/env node
// CF-ANALYZE-NULL-BASEBALL-POOL (Drew, 2026-08-05).
//
// Filters the null-bccpMatchedAs bucket down to the baseball pool
// rows that were actually run through the matcher — i.e. source =
// bulk-build-from-pool AND sport = baseball. These are the ~30K rows
// showing on the CONFIRMED shortfall (89.9% → 95% target). Sports
// other than baseball + ingest-auto-seed rows aren't matched and are
// noise for the 95% chase.
//
// Env: COSMOS_CONNECTION_STRING required
//      TOP_N (default 40)

const { CosmosClient } = require("@azure/cosmos");

if (!process.env.COSMOS_CONNECTION_STRING) {
  console.error("COSMOS_CONNECTION_STRING required");
  process.exit(1);
}
const TOP_N = Math.max(1, Number(process.env.TOP_N || 40));
const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const catalog = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

async function main() {
  const q = {
    query: `SELECT c.year, c.setKey, c.parallel, c.playerName, c.bccpNotMatchedReason
            FROM c
            WHERE c.sport = "baseball"
              AND c.source = "bulk-build-from-pool"
              AND NOT IS_DEFINED(c.bccpMatchedAs)`,
  };
  const it = catalog.items.query(q, { maxItemCount: 1000 });
  const bySetKey = new Map();
  const byReason = new Map();
  const byYear = new Map();
  const byYearSetKey = new Map();
  const samples = new Map();
  let total = 0;
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      total++;
      const sk = r.setKey || "(none)";
      bySetKey.set(sk, (bySetKey.get(sk) || 0) + 1);
      const reason = r.bccpNotMatchedReason || "(no reason)";
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
      byYear.set(r.year, (byYear.get(r.year) || 0) + 1);
      const ys = `${r.year}::${sk}`;
      byYearSetKey.set(ys, (byYearSetKey.get(ys) || 0) + 1);
      if (!samples.has(ys) && samples.size < 5000) {
        samples.set(ys, {
          parallel: r.parallel,
          player: r.playerName,
          reason: r.bccpNotMatchedReason,
        });
      }
    }
  }
  console.log(`▸ BASEBALL POOL null-matched rows: ${total.toLocaleString()}\n`);
  console.log(`By failure reason:`);
  for (const [r, c] of [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(c).padStart(6)}  ${r}`);
  }
  console.log(`\nTop ${TOP_N} setKeys blocking baseball pool rows:`);
  for (const [sk, c] of [...bySetKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)) {
    console.log(`  ${String(c).padStart(6)}  ${sk}`);
  }
  console.log(`\nTop ${TOP_N} year+setKey combos:`);
  for (const [ys, c] of [...byYearSetKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)) {
    const s = samples.get(ys);
    const suffix = s ? `  eg parallel="${s.parallel}"  player="${s.player}"  reason=${s.reason}` : "";
    console.log(`  ${String(c).padStart(6)}  ${ys}${suffix}`);
  }
  console.log(`\nBy year (all):`);
  for (const [y, c] of [...byYear.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(6)}  y=${y}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
