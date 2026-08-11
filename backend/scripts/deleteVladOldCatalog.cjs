// Delete via container partitionKey definition inspection
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const catalog = db.container("card_catalog");
  const { resource: def } = await catalog.read();
  console.log("partitionKey definition:", JSON.stringify(def.partitionKey));

  const OLD = "hiq:baseball:2018:bowman-chrome-mega-box:bcp150:base:no-auto";
  // full doc via query
  const { resources } = await catalog.items.query({
    query: `SELECT * FROM c WHERE c.id = @id`,
    parameters: [{ name: "@id", value: OLD }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`found ${resources.length}`);
  if (resources.length === 0) return;
  const doc = resources[0];
  // find partition key path (e.g. "/sport" → "sport")
  const pkPath = (def.partitionKey.paths || [])[0] || "/sport";
  const pkName = pkPath.replace(/^\//, "");
  const pkVal = doc[pkName];
  console.log(`  pkPath=${pkPath} pkVal=${JSON.stringify(pkVal)}`);
  try {
    await catalog.item(OLD, pkVal).delete();
    console.log(`  ✓ deleted`);
  } catch (err) {
    console.warn(`  fail: code=${err.code} msg=${err.message||err}`);
  }
  // Verify
  const { resources: after } = await catalog.items.query({
    query: `SELECT c.id FROM c WHERE c.id = @id`,
    parameters: [{ name: "@id", value: OLD }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  after: ${after.length} row(s) remain`);
}
main().catch(e => { console.error(e); process.exit(1); });
