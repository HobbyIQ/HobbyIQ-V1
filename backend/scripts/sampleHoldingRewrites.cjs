// Sample the 14 holding rewrites — show each old → new + full context
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { deriveHoldingSlug } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "holdingSlug.service.js"));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const portfolio = new CosmosClient(conn).database("hobbyiq").container("portfolio");
  const { resources } = await portfolio.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.holdings)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const doc of resources) {
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      if (!h || typeof h !== "object") continue;
      const old = h.hobbyiqCardId;
      const next = deriveHoldingSlug(h);
      if (!next || next === old) continue;
      console.log(`\nuser=${doc.userId?.slice(-8)} holding=${hid.slice(0,8)}`);
      console.log(`  OLD: ${old}`);
      console.log(`  NEW: ${next}`);
      console.log(`  player="${h.playerName}"  #="${h.cardNumber}"  year=${h.cardYear}`);
      console.log(`  setName="${h.setName}"  product="${h.product}"`);
      console.log(`  parallel="${h.parallel}"  isAuto=${h.isAuto}  printRun=${h.printRun}`);
      console.log(`  cardTitle="${(h.cardTitle||"").slice(0,90)}"`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
