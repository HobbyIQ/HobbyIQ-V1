// Audit holdings across ALL portfolios where cardId != hobbyiqCardId.
// Both slugs start with "hiq:" but differ — usually because cardNumber
// or setKey got lossy-normalized on one side (e.g. BDP129 → 129).
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");

  const { resources: docs } = await portfolio.items.query({
    query: "SELECT c.id, c.userId, c.holdings FROM c",
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log("Portfolio docs scanned:", docs.length);

  let totalHoldings = 0;
  let diverged = 0;
  const samples = [];

  for (const doc of docs) {
    const raw = doc.holdings || {};
    const holdings = Array.isArray(raw) ? raw : Object.values(raw);
    for (const h of holdings) {
      totalHoldings++;
      const cid = h.cardId;
      const hid = h.hobbyiqCardId;
      if (
        typeof cid === "string" &&
        typeof hid === "string" &&
        cid.startsWith("hiq:") &&
        hid.startsWith("hiq:") &&
        cid !== hid
      ) {
        diverged++;
        if (samples.length < 20) {
          samples.push({
            userId: doc.userId?.slice(0, 20),
            holdingId: h.id?.slice(0, 12),
            player: h.playerName,
            cardNumber: h.cardNumber,
            setName: h.setName,
            cardId: cid,
            hobbyiqCardId: hid,
          });
        }
      }
    }
  }

  console.log(`Total holdings: ${totalHoldings}`);
  console.log(`Diverged (cardId != hobbyiqCardId, both hiq:): ${diverged}`);
  console.log("\nSample divergences:");
  for (const s of samples) console.log(JSON.stringify(s, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
