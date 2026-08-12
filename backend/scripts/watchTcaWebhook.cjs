const { CosmosClient } = require("@azure/cosmos");
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");
  const now = new Date().toISOString();
  const rs = await sc.items.query({
    query: "SELECT TOP 10 c.observedAt, c.soldAt FROM c WHERE c.source = 'tca-ebay' ORDER BY c.observedAt DESC",
  }, { maxItemCount: 10 }).fetchAll();
  console.log(`[${now}] latest 10 tca-ebay observedAt / soldAt:`);
  for (const r of rs.resources) console.log(`  o=${r.observedAt}  s=${r.soldAt}`);
})().catch(e => { console.error(e); process.exit(1); });
