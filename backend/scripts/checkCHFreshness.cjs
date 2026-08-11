// Check CardHedge ingest state
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const sold = db.container("sold_comps");
  const ch = db.container("ch_daily_sales");

  console.log("=== sold_comps by source last 14d (observedAt) ===");
  const cutoff = new Date(Date.now() - 14*24*60*60*1000).toISOString();
  const q1 = await sold.items.query({
    query: `SELECT c.source, SUBSTRING(c.observedAt, 0, 10) AS day, COUNT(1) AS n
            FROM c WHERE c.observedAt >= @c GROUP BY c.source, SUBSTRING(c.observedAt, 0, 10)`,
    parameters: [{ name: "@c", value: cutoff }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const bySrc = {};
  for (const r of q1.resources) {
    if (!bySrc[r.source]) bySrc[r.source] = {};
    bySrc[r.source][r.day] = r.n;
  }
  for (const src of Object.keys(bySrc).sort()) {
    console.log(`  ${src}:`);
    for (const day of Object.keys(bySrc[src]).sort()) console.log(`    ${day}: ${bySrc[src][day]}`);
  }

  console.log("\n=== ch_daily_sales most recent 5 (raw CH ingest) ===");
  try {
    const q2 = await ch.items.query({
      query: `SELECT TOP 5 c.id, c.card_id, c.sold_at, c.observed_at, c.price FROM c ORDER BY c.observed_at DESC`,
    }, { enableCrossPartitionQuery: true }).fetchAll();
    for (const r of q2.resources) {
      console.log(`  observed=${r.observed_at}  sold=${r.sold_at}  $${r.price}  card_id=${r.card_id}`);
    }
  } catch (err) { console.warn(`  ch_daily_sales read failed: ${err.message||err}`); }

  console.log("\n=== ch_daily_sales row count last 7d ===");
  try {
    const cutoff2 = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    const q3 = await ch.items.query({
      query: `SELECT SUBSTRING(c.observed_at, 0, 10) AS day, COUNT(1) AS n
              FROM c WHERE c.observed_at >= @c GROUP BY SUBSTRING(c.observed_at, 0, 10)`,
      parameters: [{ name: "@c", value: cutoff2 }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    for (const r of q3.resources.sort((a,b)=>a.day.localeCompare(b.day))) console.log(`  ${r.day}: ${r.n}`);
  } catch (err) { console.warn(`  ch_daily_sales aggregate failed: ${err.message||err}`); }
}
main().catch(e => { console.error(e); process.exit(1); });
