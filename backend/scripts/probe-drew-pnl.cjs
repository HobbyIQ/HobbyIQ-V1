#!/usr/bin/env node
// Simulate what /erp/pnl SHOULD return for Drew — pure aggregation against
// his live Cosmos ledger. If this returns non-zero totals but Drew's iOS
// still sees zeros, the bug is HTTP-side (URL, auth, cache) not math-side.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CosmosClient } = require("@azure/cosmos");

const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const distErp = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "erpReconciliation.service.js");
  const { aggregatePnl, listUnreconciled } = await import(pathToFileURL(distErp).href);

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");
  const { resources } = await container.items
    .query({ query: "SELECT * FROM c WHERE c.userId = @u", parameters: [{ name: "@u", value: USER_ID }] })
    .fetchAll();
  const doc = resources[0];

  const ledger = doc.ledger ?? [];
  const holdingsById = doc.holdings ?? {};

  console.log(`Simulating /erp/pnl for ${USER_ID}`);
  console.log(`Ledger entries in doc: ${ledger.length}`);

  const pnl = aggregatePnl(ledger, holdingsById, { from: undefined, to: undefined, groupBy: "month" });
  console.log("\naggregatePnl result:");
  console.log(JSON.stringify(pnl, null, 2));

  console.log("\nlistUnreconciled result:");
  const unrec = listUnreconciled(ledger);
  console.log(JSON.stringify(unrec, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
