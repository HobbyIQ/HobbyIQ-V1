// Probe: what is Verlander BDP129 slugged as, and what comps are pulled?
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");

  // 1) Find Verlander holding(s)
  const portfolio = db.container("portfolio");
  const { resources: userDocs } = await portfolio.items.query({
    query: `SELECT * FROM c WHERE c.userId = 'user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4'`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log("Portfolio docs found:", userDocs.length);
  for (const doc of userDocs) {
    // holdings may be an object keyed by id OR an array. Support both.
    const raw = doc.holdings || {};
    const holdings = Array.isArray(raw) ? raw : Object.values(raw);
    console.log("  doc.id:", doc.id, "holdings:", holdings.length);
    const matches = holdings.filter((h) =>
      /verlander/i.test(JSON.stringify(h)) || /BDP129/i.test(JSON.stringify(h))
    );
    for (const h of matches) {
      console.log("\n=== HOLDING ===");
      console.log("id:", h.id);
      console.log("hobbyiqCardId:", h.hobbyiqCardId);
      console.log("cardId (vendor):", h.cardId);
      console.log("playerName:", h.playerName);
      console.log("cardNumber:", h.cardNumber);
      console.log("setName:", h.setName);
      console.log("year:", h.year);
      console.log("grade:", JSON.stringify(h.grade));
      console.log("fairMarketValue:", h.fairMarketValue);
      console.log("marketValue:", h.marketValue);
      console.log("estimateSource:", h.estimateSource);
    }
  }

  // 2) Query sold_comps for the vendor cardId if any
  const soldComps = db.container("sold_comps");
  const verlanderCid = process.env.PROBE_CID; // pass one to probe
  if (verlanderCid) {
    const { resources: comps } = await soldComps.items.query({
      query: `SELECT TOP 20 c.cardId, c.hobbyiqCardId, c.title, c.parallel, c.grade, c.price, c.soldAt, c.source
              FROM c WHERE c.cardId = @cid OR c.hobbyiqCardId = @cid
              ORDER BY c.soldAt DESC`,
      parameters: [{ name: "@cid", value: verlanderCid }],
    }, { partitionKey: verlanderCid }).fetchAll();
    console.log("\n=== COMPS for cardId=" + verlanderCid + " (top 20 newest) ===");
    for (const c of comps) {
      console.log(`  ${c.soldAt?.slice(0, 10)} $${c.price} ${c.grade || "Raw"} ${c.parallel || "base"} — ${(c.title || "").slice(0, 90)}  [src=${c.source}]`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
