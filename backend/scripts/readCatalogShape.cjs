const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const catalog = db.container("card_catalog");
  // Read the closest existing entry to model our new one after
  const { resources: rows } = await catalog.items.query({
    query: 'SELECT * FROM c WHERE c.id = "hiq:baseball:2026:bowman:cpa-vf:gold-ink:auto:num-15"',
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log("--- Gold Ink CPA-VF catalog row ---");
  console.log(JSON.stringify(rows[0], null, 2));

  console.log("\n--- Sold comp row shape (from ebay-user-purchase) ---");
  const sold = db.container("sold_comps");
  const { resources: eup } = await sold.items.query({
    query: "SELECT TOP 1 * FROM c WHERE c.source = 'ebay-user-purchase'",
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(JSON.stringify(eup[0], null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
