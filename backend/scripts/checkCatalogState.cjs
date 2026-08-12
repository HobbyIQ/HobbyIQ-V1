// Full snapshot: total catalog + growth by source today
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const catalog = new CosmosClient(conn).database("hobbyiq").container("card_catalog");

  console.log("=== SNAPSHOT ===");
  const total = await catalog.items.query({ query: `SELECT VALUE COUNT(1) FROM c` }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`total rows: ${(total.resources[0] || 0).toLocaleString()}`);

  console.log("\n=== ROWS BY SOURCE (top 15) ===");
  const bySrc = await catalog.items.query({
    query: `SELECT c.source, COUNT(1) AS n FROM c GROUP BY c.source`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const sorted = bySrc.resources.sort((a, b) => b.n - a.n).slice(0, 15);
  for (const r of sorted) console.log(`  ${(r.source || "(no source)").padEnd(55)} ${(r.n || 0).toLocaleString()}`);

  console.log("\n=== TODAY'S NEW ROWS (source tagged 2026-08-11) ===");
  const today = await catalog.items.query({
    query: `SELECT c.source, COUNT(1) AS n FROM c WHERE CONTAINS(c.source, '2026-08-11') GROUP BY c.source`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  let todayTotal = 0;
  for (const r of today.resources.sort((a, b) => b.n - a.n)) {
    console.log(`  ${(r.source || "(no source)").padEnd(55)} ${(r.n || 0).toLocaleString()}`);
    todayTotal += r.n;
  }
  console.log(`  TOTAL:                                                      ${todayTotal.toLocaleString()}`);

  console.log("\n=== GRADE-EXPLODE PROGRESS (rows with gradeTier set) ===");
  const graded = await catalog.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE IS_DEFINED(c.gradeTier)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const ungrade = await catalog.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE c.catalogVersion = 2 AND IS_DEFINED(c.hobbyiqCardId) AND NOT IS_DEFINED(c.gradeTier)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  graded rows (built by explosion): ${(graded.resources[0] || 0).toLocaleString()}`);
  console.log(`  identities STILL awaiting explosion: ${(ungrade.resources[0] || 0).toLocaleString()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
