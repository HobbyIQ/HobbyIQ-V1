// One-off (Drew, 2026-08-07). Probe field shape on sold_comps for
// bowman-chrome / prospects rows so we know what to filter on in the
// pool-based parallel-premium calibration.

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log("=== 5 sold_comps rows tagged setKey=bowman-chrome, year=2025, parallel~refractor ===");
  const q1 = await sc.items.query({
    query: "SELECT TOP 5 c.hobbyiqCardId, c.year, c.cardYear, c.setKey, c.setName, c.parallel, c.isAuto, c.playerName, c.cardNumber, c.price, c.source FROM c WHERE c.setKey = 'bowman-chrome' AND (c.year = 2025 OR c.cardYear = 2025)",
  }, { maxItemCount: 5 }).fetchAll();
  q1.resources.forEach((r, i) => console.log(`\n  ${i + 1}. ${JSON.stringify(r).slice(0, 400)}`));

  console.log("\n\n=== parallel value distribution for bowman-chrome 2025 ===");
  const q2 = await sc.items.query({
    query: "SELECT c.parallel, COUNT(1) AS n FROM c WHERE c.setKey = 'bowman-chrome' AND (c.year = 2025 OR c.cardYear = 2025) GROUP BY c.parallel",
  }, { maxItemCount: -1 }).fetchAll();
  q2.resources.sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 20).forEach((r) => {
    console.log(`  ${String(r.parallel || "(null)").padEnd(35)} ${r.n}`);
  });

  console.log("\n=== setKey distribution for anything 'bowman' 2025 ===");
  const q3 = await sc.items.query({
    query: "SELECT c.setKey, COUNT(1) AS n FROM c WHERE CONTAINS(c.setKey, 'bowman') AND (c.year = 2025 OR c.cardYear = 2025) GROUP BY c.setKey",
  }, { maxItemCount: -1 }).fetchAll();
  q3.resources.sort((a, b) => (b.n || 0) - (a.n || 0)).forEach((r) => {
    console.log(`  ${String(r.setKey || "(null)").padEnd(35)} ${r.n}`);
  });

  console.log("\n=== year vs cardYear field usage (2025 example) ===");
  const withYear = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.year = 2025",
  }, { maxItemCount: 1 }).fetchAll();
  const withCardYear = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.cardYear = 2025",
  }, { maxItemCount: 1 }).fetchAll();
  console.log(`  rows with c.year = 2025:      ${withYear.resources[0]}`);
  console.log(`  rows with c.cardYear = 2025:  ${withCardYear.resources[0]}`);
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
