// Rigorous TCA 08-04 verification
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sold = client.database("hobbyiq").container("sold_comps");

  // 1. Sample some 08-04 rows — confirm they look like real sales
  console.log("=== sample of 08-04 sold_comps (sanity check) ===");
  const q1 = await sold.items.query({
    query: `SELECT TOP 10 c.title, c.price, c.soldAt, c.observedAt, c.source, c.playerName, c.cardYear FROM c
            WHERE c.source = 'tca-ebay'
              AND c.soldAt >= '2026-08-04T00:00:00Z'
              AND c.soldAt < '2026-08-05T00:00:00Z'
            ORDER BY c.price DESC`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of q1.resources) {
    console.log(`  $${r.price}  soldAt=${r.soldAt}  observedAt=${r.observedAt}  ${(r.title||"").slice(0,90)}`);
  }

  // 2. Compare 08-04 volume vs a "normal week" (last 21 days average)
  console.log("\n=== volume comparison: last 21 days ===");
  const now = Date.now();
  const q2 = await sold.items.query({
    query: `SELECT SUBSTRING(c.soldAt, 0, 10) AS day, COUNT(1) AS n FROM c
            WHERE c.source = 'tca-ebay' AND c.soldAt >= @cutoff AND c.soldAt < @today
            GROUP BY SUBSTRING(c.soldAt, 0, 10)`,
    parameters: [
      { name: "@cutoff", value: new Date(now - 21*24*60*60*1000).toISOString() },
      { name: "@today", value: new Date(now - 4*24*60*60*1000).toISOString() }, // exclude ingest-lag days
    ],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const daily = q2.resources.sort((a,b)=>a.day.localeCompare(b.day));
  const counts = daily.map(r => r.n);
  const mean = counts.reduce((a,b)=>a+b,0) / (counts.length || 1);
  const median = counts.length ? counts.slice().sort((a,b)=>a-b)[Math.floor(counts.length/2)] : 0;
  console.log(`  mean=${mean.toFixed(0)}  median=${median}  min=${Math.min(...counts)}  max=${Math.max(...counts)}`);
  for (const r of daily) {
    const flag = r.n < median * 0.3 ? " ← LOW" : r.n > median * 3 ? " ← HIGH" : "";
    console.log(`  ${r.day}: ${r.n}${flag}`);
  }

  // 3. Source-day matrix — verify 08-04 sold_comps came from tca-ebay
  //    specifically (not accidentally counted from another source).
  console.log("\n=== 08-04 breakdown by source ===");
  const q3 = await sold.items.query({
    query: `SELECT c.source, COUNT(1) AS n FROM c
            WHERE c.soldAt >= '2026-08-04T00:00:00Z' AND c.soldAt < '2026-08-05T00:00:00Z'
            GROUP BY c.source`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of q3.resources) console.log(`  ${r.source ?? "(null)"}: ${r.n}`);

  // 4. observedAt distribution for 08-04 sales — when did we actually ingest them?
  console.log("\n=== 08-04 sales: observedAt distribution (which day we caught them) ===");
  const q4 = await sold.items.query({
    query: `SELECT SUBSTRING(c.observedAt, 0, 10) AS observedDay, COUNT(1) AS n FROM c
            WHERE c.source = 'tca-ebay'
              AND c.soldAt >= '2026-08-04T00:00:00Z'
              AND c.soldAt < '2026-08-05T00:00:00Z'
            GROUP BY SUBSTRING(c.observedAt, 0, 10)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of q4.resources.sort((a,b)=>a.observedDay.localeCompare(b.observedDay))) {
    console.log(`  observed on ${r.observedDay}: ${r.n}`);
  }

  // 5. Historical: what did 07-28 (a normal Monday) look like?
  console.log("\n=== reference day comparison: 08-01 through 08-04 by source ===");
  const q5 = await sold.items.query({
    query: `SELECT SUBSTRING(c.soldAt, 0, 10) AS day, c.source, COUNT(1) AS n FROM c
            WHERE c.soldAt >= '2026-08-01T00:00:00Z' AND c.soldAt < '2026-08-05T00:00:00Z'
              AND c.source IN ('tca-ebay', 'cardhedge', 'cardsight')
            GROUP BY SUBSTRING(c.soldAt, 0, 10), c.source`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const bySrc = {};
  for (const r of q5.resources) {
    if (!bySrc[r.day]) bySrc[r.day] = {};
    bySrc[r.day][r.source] = r.n;
  }
  for (const day of Object.keys(bySrc).sort()) {
    const b = bySrc[day];
    console.log(`  ${day}: tca=${b["tca-ebay"]||0} ch=${b["cardhedge"]||0} cs=${b["cardsight"]||0}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
