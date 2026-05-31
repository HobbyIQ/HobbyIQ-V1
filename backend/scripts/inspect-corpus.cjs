// Diagnostic: list all containers in the hobbyiq Cosmos DB.
const { CosmosClient } = require("@azure/cosmos");
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
(async () => {
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const { resources } = await db.containers.readAll().fetchAll();
  console.log("=== Containers in 'hobbyiq' DB ===");
  for (const c of resources) {
    console.log("  -", c.id, "(partition:", JSON.stringify(c.partitionKey?.paths), ")");
  }
  console.log(`Total: ${resources.length}`);

  // Also list databases on this account in case there's a non-hobbyiq DB
  const { resources: dbs } = await client.databases.readAll().fetchAll();
  console.log("=== Databases on this account ===");
  for (const d of dbs) console.log("  -", d.id);
})().catch((e) => { console.error("ERR:", e.message); process.exit(2); });
