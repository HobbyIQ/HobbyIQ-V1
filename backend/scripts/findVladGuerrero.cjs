// Post-reslug: check current state of Vlad BCP150 (catalog + sold_comps)
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const catalog = db.container("card_catalog");
  const sold = db.container("sold_comps");

  console.log("=== catalog: 2018 BCP150 (any variant) ===");
  const cq = await catalog.items.query({
    query: `SELECT c.id, c.hobbyiqCardId, c.playerName, c.setKey, c.setName, c.cardNumber, c.parallel, c.isAuto, c.sport FROM c
            WHERE c.cardYear = 2018 AND LOWER(c.cardNumber) = 'bcp150'`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`[${cq.resources.length} catalog rows]`);
  for (const r of cq.resources) {
    console.log(`  id=${r.id}`);
    console.log(`    player=${r.playerName} sport=${r.sport} setKey=${r.setKey} #=${r.cardNumber} parallel=${r.parallel} auto=${r.isAuto}`);
  }

  console.log("\n=== sold_comps for Vlad BCP150 (post-reslug) ===");
  const sq = await sold.items.query({
    query: `SELECT DISTINCT c.hobbyiqCardId, COUNT(1) AS n FROM c
            WHERE CONTAINS(LOWER(c.playerName ?? ''), 'guerrero')
              AND c.cardYear = 2018 AND LOWER(c.cardNumber) = 'bcp150'
            GROUP BY c.hobbyiqCardId`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of sq.resources) console.log(`  ${r.hobbyiqCardId}: ${r.n}`);

  console.log("\n=== sample recent sold_comps @ bowman-chrome:bcp150 (post-reslug) ===");
  const s2 = await sold.items.query({
    query: `SELECT TOP 8 c.title, c.parallel, c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.source FROM c
            WHERE c.hobbyiqCardId = 'hiq:baseball:2018:bowman-chrome:bcp150:base:no-auto'
            ORDER BY c.soldAt DESC`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`[${s2.resources.length} rows]`);
  for (const r of s2.resources) {
    console.log(`  ${r.soldAt}  $${r.price}  ${r.gradeCompany||"raw"}  ${(r.title||"").slice(0,80)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
