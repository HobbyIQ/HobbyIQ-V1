// One-off ops probe (Drew, 2026-08-07). Sanity-check TCA row landing
// vs cleaning state. Answers "are TCA rows in sold_comps and clean?"

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log("=== TCA-EBAY LATEST 5 ROWS BY observedAt ===");
  const latest5 = await sc.items.query({
    query: "SELECT TOP 5 c.observedAt, c.soldAt, c.hobbyiqCardId, c.title, c.price, c.playerName, c.cardId FROM c WHERE c.source = 'tca-ebay' ORDER BY c.observedAt DESC",
  }, { maxItemCount: 5 }).fetchAll();
  for (const r of latest5.resources) {
    console.log(`  observedAt=${r.observedAt}  soldAt=${r.soldAt}`);
    console.log(`    hiq=${(r.hobbyiqCardId || "(none)").slice(0, 80)}`);
    console.log(`    player=${r.playerName || "(none)"}  price=${r.price}  title=${(r.title || "").slice(0, 60)}`);
  }

  console.log("\n=== TCA-EBAY COUNT BY observedAt DAY (last 10 days) ===");
  const byDay = await sc.items.query({
    query: "SELECT SUBSTRING(c.observedAt, 0, 10) AS day, COUNT(1) AS n FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= '2026-07-29' GROUP BY SUBSTRING(c.observedAt, 0, 10)",
  }, { maxItemCount: -1 }).fetchAll();
  for (const r of byDay.resources.sort((a, b) => String(b.day).localeCompare(a.day))) {
    console.log(`  ${r.day}  ${r.n}`);
  }

  console.log("\n=== TCA-EBAY: hobbyiqCardId COVERAGE (does canonical slug exist?) ===");
  const total = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= '2026-07-29'",
  }, { maxItemCount: 1 }).fetchAll();
  const withHiq = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= '2026-07-29' AND IS_DEFINED(c.hobbyiqCardId)",
  }, { maxItemCount: 1 }).fetchAll();
  const withPlayer = await sc.items.query({
    query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= '2026-07-29' AND IS_DEFINED(c.playerName)",
  }, { maxItemCount: 1 }).fetchAll();
  console.log(`  total rows (last 10d):        ${total.resources[0]}`);
  console.log(`  with hobbyiqCardId (clean):   ${withHiq.resources[0]}`);
  console.log(`  with playerName (parsed):     ${withPlayer.resources[0]}`);

  console.log("\n=== TCA-EBAY: soldAt vs observedAt DRIFT (webhook backlog vs fresh) ===");
  const soldAtSample = await sc.items.query({
    query: "SELECT TOP 20 c.soldAt, c.observedAt FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= '2026-08-06' ORDER BY c.observedAt DESC",
  }, { maxItemCount: 20 }).fetchAll();
  let freshCount = 0;
  let backlogCount = 0;
  const now = Date.now();
  for (const r of soldAtSample.resources) {
    const soldMs = new Date(r.soldAt).getTime();
    const daysOld = (now - soldMs) / 86400000;
    if (daysOld < 7) freshCount++; else backlogCount++;
  }
  console.log(`  Sample of 20 recent-observed rows:`);
  console.log(`    soldAt within last 7d (fresh): ${freshCount}`);
  console.log(`    soldAt older than 7d (backlog): ${backlogCount}`);
  if (soldAtSample.resources.length) {
    const oldestSoldAt = soldAtSample.resources.map(r => r.soldAt).sort()[0];
    const newestSoldAt = soldAtSample.resources.map(r => r.soldAt).sort().pop();
    console.log(`    soldAt range in sample: ${oldestSoldAt} .. ${newestSoldAt}`);
  }
}

main().catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
