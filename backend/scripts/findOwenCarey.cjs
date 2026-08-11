// Post-base-to-refractor verification for Owen Carey
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const sold = db.container("sold_comps");

  console.log("=== all Owen Carey CPA-OC slugs in sold_comps ===");
  const sq = await sold.items.query({
    query: `SELECT c.hobbyiqCardId, COUNT(1) AS n FROM c
            WHERE CONTAINS(LOWER(c.playerName ?? ''), 'owen carey')
              AND LOWER(c.cardNumber) = 'cpa-oc'
            GROUP BY c.hobbyiqCardId`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const total = sq.resources.reduce((a,b)=>a+b.n,0);
  for (const r of sq.resources.sort((a,b)=>b.n-a.n)) console.log(`  ${r.hobbyiqCardId}: ${r.n}`);
  console.log(`  TOTAL: ${total}`);

  console.log("\n=== canonical slug (Refractor Auto /499) pool ===");
  const target = "hiq:baseball:2026:bowman-chrome:cpa-oc:refractor:auto";
  const q2 = await sold.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
    parameters: [{ name: "@s", value: target }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  ${target}: ${q2.resources[0]} rows`);

  // How does the base->refractor rule affect the overall CPA-*/TCPA-*/CRA- pool?
  console.log("\n=== residual :base:auto for chrome autos (should be 0 after reslug) ===");
  const q3 = await sold.items.query({
    query: `SELECT VALUE COUNT(1) FROM c
            WHERE IS_STRING(c.hobbyiqCardId)
              AND (
                (CONTAINS(c.hobbyiqCardId, ':bowman-chrome:cpa') AND CONTAINS(c.hobbyiqCardId, ':base:auto')) OR
                (CONTAINS(c.hobbyiqCardId, ':topps-chrome:tcpa') AND CONTAINS(c.hobbyiqCardId, ':base:auto')) OR
                (CONTAINS(c.hobbyiqCardId, ':topps-chrome:cra') AND CONTAINS(c.hobbyiqCardId, ':base:auto'))
              )`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  residual :base:auto rows for chrome auto subsets: ${q3.resources[0]}`);
}
main().catch(e => { console.error(e); process.exit(1); });
