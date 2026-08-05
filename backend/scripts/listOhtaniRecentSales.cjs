const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sold = client.database("hobbyiq").container("sold_comps");
  const cardId = "1625707759165x532501567379903170";

  const { resources: rows } = await sold.items.query({
    query: "SELECT c.price, c.soldAt, c.parallel, c.source, c.title FROM c WHERE c.cardId = @cid AND c.gradeCompany = 'PSA' AND c.gradeValue = 9 AND c.price > 0 ORDER BY c.soldAt DESC",
    parameters: [{ name: "@cid", value: cardId }],
  }, { partitionKey: cardId }).fetchAll();

  console.log(`Total PSA 9 sales: ${rows.length}\n`);
  console.log("=== Most recent 30 sales ===");
  for (const r of rows.slice(0, 30)) {
    console.log(`  ${r.soldAt?.slice(0, 10)} $${String(r.price).padStart(7)} src=${r.source.padEnd(12)} parallel="${r.parallel || "(none)"}"`);
  }

  // Bucket by month for trend visibility
  console.log("\n=== Monthly buckets ===");
  const monthly = new Map();
  for (const r of rows) {
    const m = (r.soldAt || "").slice(0, 7);
    if (!m) continue;
    let arr = monthly.get(m);
    if (!arr) { arr = []; monthly.set(m, arr); }
    arr.push(Number(r.price));
  }
  const monthKeys = [...monthly.keys()].sort().reverse();
  for (const m of monthKeys.slice(0, 8)) {
    const prices = monthly.get(m).sort((a, b) => a - b);
    const med = prices[Math.floor(prices.length / 2)];
    const min = prices[0];
    const max = prices[prices.length - 1];
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    console.log(`  ${m}: n=${prices.length}  median=$${med.toFixed(0).padStart(5)}  avg=$${avg.toFixed(0).padStart(5)}  range=$${min.toFixed(0)}-$${max.toFixed(0)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
