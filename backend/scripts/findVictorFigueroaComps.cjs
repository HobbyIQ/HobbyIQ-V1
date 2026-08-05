const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const sold = db.container("sold_comps");
  const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

  // Any sold_comp from Drew's contributor bucket
  console.log("=== Drew's contributor sold_comps ===");
  const { resources: mine } = await sold.items.query({
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.title, c.source, c.cardNumber FROM c WHERE c.contributorUserId = @uid",
    parameters: [{ name: "@uid", value: USER_ID }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  ${mine.length} contributed comps total`);
  const figs = mine.filter(r => {
    const scan = JSON.stringify(r).toLowerCase();
    return scan.includes("figueroa") || scan.includes("cpa-vf");
  });
  console.log(`  ${figs.length} Figueroa/CPA-VF matches:`);
  for (const r of figs) {
    console.log(`    ${r.soldAt?.slice(0, 10)} $${r.price} src=${r.source} cardId=${r.cardId} hiq=${r.hobbyiqCardId} parallel="${r.parallel}" title="${(r.title || "").slice(0, 100)}"`);
  }

  // Any Figueroa row regardless of contributor
  console.log("\n=== ANY Figueroa row in sold_comps ===");
  const { resources: allFig } = await sold.items.query({
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.title, c.source, c.contributorUserId, c.cardNumber FROM c WHERE CONTAINS(LOWER(c.title ?? ''), 'figueroa') OR CONTAINS(LOWER(c.playerName ?? ''), 'figueroa')",
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  ${allFig.length} rows`);
  for (const r of allFig.slice(0, 20)) {
    console.log(`    ${r.soldAt?.slice(0, 10)} $${r.price} src=${r.source} cardId=${r.cardId} parallel="${r.parallel}" title="${(r.title || "").slice(0, 100)}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
