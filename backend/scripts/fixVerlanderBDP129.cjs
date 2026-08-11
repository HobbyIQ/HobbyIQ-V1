// Verlander BDP129 2005 is CHROME (per Drew 2026-08-10). Restore
// bowman-chrome slug + fix setName so future generator runs don't flip
// it back to bowman-draft.
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const portfolio = new CosmosClient(conn).database("hobbyiq").container("portfolio");
  const { resources } = await portfolio.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.holdings)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const CANONICAL = "hiq:baseball:2005:bowman-chrome:bdp129:base:no-auto";
  for (const doc of resources) {
    let mutated = false;
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      if (!h || typeof h !== "object") continue;
      if (String(h.playerName || "").toLowerCase().includes("verlander") &&
          String(h.cardNumber || "").toLowerCase() === "bdp129" &&
          Number(h.cardYear) === 2005) {
        console.log(`user=${doc.userId?.slice(-8)} holding=${hid.slice(0,8)}`);
        console.log(`  BEFORE: hobbyiqCardId=${h.hobbyiqCardId}  setName="${h.setName}"`);
        doc.holdings[hid].hobbyiqCardId = CANONICAL;
        doc.holdings[hid].setName = "2005 Bowman Chrome Draft Picks & Prospects";
        doc.holdings[hid].hobbyiqCardIdSource = "manual-chrome-2026-08-10";
        doc.holdings[hid].hobbyiqCardIdNote = "Confirmed chrome by Drew; do not re-derive to paper";
        console.log(`  AFTER:  hobbyiqCardId=${CANONICAL}  setName="2005 Bowman Chrome Draft Picks & Prospects"`);
        mutated = true;
      }
    }
    if (mutated) {
      doc.lastUpdated = new Date().toISOString();
      await portfolio.item(doc.id, doc.userId).replace(doc);
      console.log(`  ✓ saved`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
