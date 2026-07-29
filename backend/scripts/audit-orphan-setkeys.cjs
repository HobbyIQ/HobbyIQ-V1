#!/usr/bin/env node
// CF-AUDIT-ORPHAN-SETKEYS (Drew, 2026-07-29). Diagnostic — count
// sold_comps rows whose slug carries a bare subset-name setKey (no
// brand prefix). These are candidates for normalization to include
// their brand parent (prizm → panini-prizm, heritage → topps-heritage).
//
// The family ladder (PR #939) handles these at query time via
// subset-to-brand fallback, so this is READ-ONLY diagnostic — no
// writes. Use it to decide whether normalization is worth it.

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const ORPHAN_SUBSETS = [
  // Panini-family
  "prizm", "optic", "select", "mosaic", "immaculate", "flawless",
  "contenders", "absolute", "chronicles",
  // Topps-family
  "heritage", "finest", "pristine", "transcendent", "dynasty",
  "tribute", "inception",
];

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[audit-orphan-setkeys] counting sold_comps rows by orphan setKey...`);
  console.log(`  looking at ${ORPHAN_SUBSETS.length} known subset names\n`);

  const totalsByKey = {};
  let grandTotal = 0;

  for (const subset of ORPHAN_SUBSETS) {
    // Slugs are hiq:sport:year:setKey:cardNumber:parallel:autoFlag
    // Match ":subset:" for exact orphan (no brand prefix before it).
    const pattern = `:${subset}:`;
    const q = `SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(c.hobbyiqCardId, "${pattern}")`;
    try {
      const { resources } = await sc.items.query({ query: q }).fetchAll();
      const count = Number(resources?.[0] ?? 0);
      if (count > 0) {
        totalsByKey[subset] = count;
        grandTotal += count;
        console.log(`  :${subset}: → ${count}`);
      }
    } catch (e) {
      console.warn(`  :${subset}: query failed — ${e?.message ?? e}`);
    }
  }

  console.log(`\nTotal orphan-setKey rows: ${grandTotal}`);
  if (grandTotal === 0) {
    console.log(`✓ No normalization needed — every setKey already carries its brand prefix.`);
  } else {
    console.log(`\nOptional follow-up: write a normalize-orphan-setkeys.cjs to`);
    console.log(`re-slug these ${grandTotal} rows into their brand-prefixed setKey.`);
    console.log(`Not blocking — family ladder handles lookup via subset-to-brand fallback.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
