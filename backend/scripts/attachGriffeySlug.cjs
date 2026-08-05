const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database("hobbyiq");
  const portfolio = db.container("portfolio");
  const USER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

  const { resource: doc } = await portfolio.item(USER, USER).read();
  const HOLDING = "ccf2e618-934a-489d-b46a-39be8eb18768";
  const h = doc.holdings[HOLDING];
  if (!h) { console.log("Not found"); return; }

  const slug = "hiq:baseball:1991:1991-score-baseball:396:base:no-auto";
  console.log(`Attaching slug ${slug} to Griffey holding...`);
  h.hobbyiqCardId = slug;
  h.cardId = slug;
  await portfolio.item(USER, USER).replace(doc);
  console.log("Done — reprice the holding to pick up the new pool query.");
}
main().catch((e) => { console.error(e); process.exit(1); });
