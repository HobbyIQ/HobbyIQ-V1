#!/usr/bin/env node
/**
 * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-PRODUCT, the census (Drew, 2026-09-09).
 *
 * READ ONLY. This script has no write path and takes no APPLY flag.
 *
 * WHY IT EXISTS. `normalizeSetKey("metal-universe-heavy-metal")` returned
 * "metal-universe", so the 1996 Metal Universe Heavy Metal ruling file wrote
 * ZERO rows under its own key: all ten resolved onto BASE-SET addresses held
 * at higher authority and were absorbed as `keptExisting`. The run counted
 * "10 written" and the catalog gained nothing. Heavy Metal #2 is Barry Bonds
 * while BASE #2 is Brady Anderson, so the collapse did not merely lose an
 * insert -- it pointed Bonds's card at Brady Anderson's row and its pool.
 *
 * Heavy Metal is now a non-collapsing key. This census answers the obvious
 * next question -- WHICH OTHER named insert sets does the normalizer still
 * fold into their parents -- WITHOUT changing any of them. A key here is a
 * candidate for a ruling, never a defect to auto-fix: some collapses are
 * correct (a rung that is genuinely a parallel of the base card), and only
 * the person who knows the product can tell those apart. Hence report-only.
 *
 * METHOD. For every distinct setKey in card_catalog, run it back through
 * normalizeSetKey. A key that does not map to itself is not a fixed point:
 * rows minted under it land somewhere else. Report those with row counts and
 * the parent they fold into, so the ruling can be made on volume and product,
 * not on a name.
 */
const { CosmosClient } = require("@azure/cosmos");
const { normalizeSetKey } = require("../dist/services/portfolioiq/hobbyIqCardId.service.js");

const f = (n) => Number(n).toLocaleString("en-US");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (String(process.env.APPLY || "") === "true") {
    console.error("FATAL: this census is READ ONLY — it has no write path. Re-run without APPLY.");
    process.exit(2);
  }
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cat = client.database("hobbyiq").container("card_catalog");

  console.log("census-collapsed-insert-keys — READ ONLY, no writes\n");
  // A cross-partition GROUP BY over card_catalog does not return here (it is
  // the same shape that hung the 2026-09-08 census at 8+ minutes and came back
  // empty). DISTINCT VALUE pages reliably, and the per-key count is a cheap
  // COUNT once the key list is known -- and only for the keys that actually
  // collapse, which is a small minority.
  const distinct = cat.items.query("SELECT DISTINCT VALUE c.setKey FROM c", { maxItemCount: 1000 });
  const keys = [];
  while (distinct.hasMoreResults()) {
    const { resources } = await distinct.fetchNext();
    if (!resources) break;
    for (const k of resources) if (k) keys.push({ setKey: k, rows: null });
  }
  console.log(`distinct setKeys in card_catalog: ${f(keys.length)}\n`);

  const collapsed = [];
  for (const k of keys) {
    const key = String(k.setKey || "");
    if (!key) continue;
    let mapped;
    try { mapped = normalizeSetKey(key); } catch { continue; }
    if (mapped && mapped !== key) collapsed.push({ key, mapped, rows: 0 });
  }
  // Count only the collapsing keys: a COUNT per key is affordable for the few
  // that collapse and unaffordable for all of them.
  for (const c of collapsed) {
    try {
      const q = cat.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.setKey = @k",
        parameters: [{ name: "@k", value: c.key }],
      }, { maxItemCount: 1 });
      const { resources } = await q.fetchNext();
      c.rows = Number(resources && resources[0]) || 0;
    } catch { c.rows = -1; }
  }
  collapsed.sort((a, b) => b.rows - a.rows);

  console.log(`setKeys that are NOT fixed points of normalizeSetKey: ${f(collapsed.length)}`);
  console.log("(rows minted under these land under `folds into` instead)\n");
  console.log("      rows  setKey                                        folds into");
  console.log("  --------  --------------------------------------------  ----------------------------");
  for (const c of collapsed) {
    console.log(`  ${String(f(c.rows)).padStart(8)}  ${c.key.padEnd(44).slice(0, 44)}  ${c.mapped}`);
  }
  console.log(`\ntotal rows under non-fixed-point keys: ${f(collapsed.reduce((a, c) => a + c.rows, 0))}`);
  console.log("\nNOTHING WAS CHANGED. Each line is a candidate for a ruling: a collapse is");
  console.log("correct when the key really is a rung of its parent, and wrong when it names");
  console.log("a distinct product whose cards carry their own numbering (the Heavy Metal");
  console.log("shape: insert #2 is a different player from base #2).");
}

main().catch((e) => { console.error(e); process.exit(1); });
