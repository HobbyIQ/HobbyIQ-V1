const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database("hobbyiq");
  const portfolio = db.container("portfolio");
  const sold = db.container("sold_comps");
  const USER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

  const { resource: doc } = await portfolio.item(USER, USER).read();
  const holdings = doc.holdings || {};

  const suspicious = [
    "0a9afe09-1152-48fa-abd4-b9b7952a1bcb", // Cam Caminiti
    "ead59318-27f6-4a54-b34a-3ea4c34b4cae", // Owen Carey (Chrome Refractor)
    "92d07730-b74f-4bd1-b95c-de6e93ea9b1c", // Nick Kurtz
    "86cb8844-9e57-45ff-a44a-a75c8c2b5b1e", // Studio Griffey
    "277b05a3", // Ripken PSA 8
    "0df03a48", // Rivera BGS 9
  ];

  for (const holdingId of suspicious) {
    const h = Object.values(holdings).find(x => x.id?.startsWith(holdingId.split("-")[0]));
    if (!h) continue;
    console.log("\n===", h.playerName, h.cardYear, h.product, h.parallel, "===");
    console.log("  holdingId:", h.id);
    console.log("  cardId:", h.cardId);
    console.log("  hobbyiqCardId:", h.hobbyiqCardId);
    console.log("  cost:", h.totalCostBasis ?? h.purchasePrice);
    console.log("  FMV:", h.fairMarketValue);
    console.log("  EST:", h.estimatedValue);
    console.log("  basis:", h.estimateBasis);
    console.log("  grade:", h.gradeCompany, h.gradeValue);
    console.log("  isAuto:", h.isAuto);
    console.log("  cardNumber:", h.cardNumber);
    console.log("  pricingSourceMeta:", JSON.stringify(h.pricingSourceMeta || {}));

    // Pool for cardId
    if (h.cardId) {
      const { resources: comps } = await sold.items.query({
        query: "SELECT c.price, c.gradeCompany, c.gradeValue, c.parallel, c.source, c.title, c.isAuto FROM c WHERE c.cardId = @cid",
        parameters: [{ name: "@cid", value: h.cardId }],
      }, { partitionKey: h.cardId }).fetchAll();
      const parallels = new Map();
      for (const cp of comps) {
        const key = (cp.parallel || "").toLowerCase().trim();
        let arr = parallels.get(key);
        if (!arr) { arr = []; parallels.set(key, arr); }
        arr.push(cp);
      }
      console.log(`  pool by cardId: ${comps.length} total`);
      for (const [k, arr] of [...parallels.entries()].sort((a,b) => b[1].length - a[1].length).slice(0, 5)) {
        const prices = arr.map(x => x.price).sort((a,b) => a-b);
        const med = prices[Math.floor(prices.length / 2)];
        console.log(`    parallel="${k}" n=${arr.length} median=$${med.toFixed(0)} range=$${prices[0].toFixed(0)}-$${prices[prices.length-1].toFixed(0)}`);
      }
    }
    if (h.hobbyiqCardId) {
      const { resources: comps } = await sold.items.query({
        query: "SELECT c.price, c.parallel, c.title FROM c WHERE c.hobbyiqCardId = @s",
        parameters: [{ name: "@s", value: h.hobbyiqCardId }],
      }).fetchAll();
      console.log(`  pool by hobbyiqCardId: ${comps.length}`);
      for (const cp of comps.slice(0, 5)) {
        console.log(`    $${cp.price} ${cp.parallel} "${(cp.title || "").slice(0, 60)}"`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
