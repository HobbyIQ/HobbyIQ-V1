const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database("hobbyiq");
  const HIQ = "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto";
  const USER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

  // 1) Confirm card_catalog seed landed
  const cat = db.container("card_catalog");
  const catRow = await cat.item(HIQ, HIQ).read().catch(() => ({ resource: null }));
  console.log("card_catalog:", catRow.resource ? "PRESENT" : "MISSING");
  if (catRow.resource) console.log(`  parallel=${catRow.resource.parallel} playerSlug=${catRow.resource.playerSlug}`);

  // 2) Confirm sold_comps seed landed
  const sold = db.container("sold_comps");
  const { resources: comps } = await sold.items.query({
    query: "SELECT c.id, c.price, c.soldAt, c.source, c.contributorUserId FROM c WHERE c.cardId = @cid",
    parameters: [{ name: "@cid", value: HIQ }],
  }, { partitionKey: HIQ }).fetchAll();
  console.log(`\nsold_comps for slug: ${comps.length} row(s)`);
  for (const r of comps) console.log(`  ${r.soldAt?.slice(0, 10)} $${r.price} src=${r.source} contributor=${r.contributorUserId}`);

  // 3) Read the actual holding
  const portfolio = db.container("portfolio");
  const { resource: userDoc } = await portfolio.item(USER, USER).read();
  const holdings = userDoc?.holdings || {};
  let match = null;
  for (const [hid, h] of Object.entries(holdings)) {
    const scan = JSON.stringify(h).toLowerCase();
    if (scan.includes("figueroa") || scan.includes("cpa-vf")) {
      match = { id: hid, h };
      break;
    }
  }
  if (!match) { console.log("\nVictor holding NOT FOUND"); return; }
  console.log(`\n=== Holding ${match.id} ===`);
  const keys = ["cardId", "hobbyiqCardId", "fairMarketValue", "estimatedValue", "estimateBasis", "valuationStatus", "pricingSource", "lastUpdated", "cardStatus", "confidence"];
  for (const k of keys) console.log(`  ${k}: ${JSON.stringify(match.h[k])}`);
}
main().catch(e => { console.error(e); process.exit(1); });
