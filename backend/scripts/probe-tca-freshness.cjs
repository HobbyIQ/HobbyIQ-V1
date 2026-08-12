const { CosmosClient } = require("@azure/cosmos");
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  // Total by source
  const bySource = await sc.items.query({
    query: "SELECT c.source, COUNT(1) AS n FROM c GROUP BY c.source"
  }, { maxItemCount: -1 }).fetchAll();
  console.log("=== TOTAL BY SOURCE ===");
  for (const r of bySource.resources.sort((a,b) => (b.n||0)-(a.n||0))) console.log(`  ${(r.source||"(null)").padEnd(28)} ${r.n}`);

  // Rows ingested in last 7 days by source
  const days = 7;
  const now = new Date();
  const cutoff = new Date(now.getTime() - days*86400000).toISOString();
  const recent = await sc.items.query({
    query: "SELECT c.source, COUNT(1) AS n FROM c WHERE c.observedAt >= @cutoff GROUP BY c.source",
    parameters: [{ name: "@cutoff", value: cutoff }]
  }, { maxItemCount: -1 }).fetchAll();
  console.log(`\n=== INGESTED IN LAST ${days}d BY SOURCE (observedAt) ===`);
  for (const r of recent.resources.sort((a,b) => (b.n||0)-(a.n||0))) console.log(`  ${(r.source||"(null)").padEnd(28)} ${r.n}`);

  // Latest observedAt per source
  const latest = await sc.items.query({
    query: "SELECT c.source, MAX(c.observedAt) AS latest FROM c GROUP BY c.source"
  }, { maxItemCount: -1 }).fetchAll();
  console.log("\n=== LATEST observedAt BY SOURCE ===");
  for (const r of latest.resources.sort((a,b) => String(b.latest).localeCompare(String(a.latest)))) {
    console.log(`  ${(r.source||"(null)").padEnd(28)} ${r.latest}`);
  }

  // Latest soldAt (real sale date) per source
  const latestSold = await sc.items.query({
    query: "SELECT c.source, MAX(c.soldAt) AS latestSold FROM c GROUP BY c.source"
  }, { maxItemCount: -1 }).fetchAll();
  console.log("\n=== LATEST soldAt (real sale date) BY SOURCE ===");
  for (const r of latestSold.resources.sort((a,b) => String(b.latestSold).localeCompare(String(a.latestSold)))) {
    console.log(`  ${(r.source||"(null)").padEnd(28)} ${r.latestSold}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
