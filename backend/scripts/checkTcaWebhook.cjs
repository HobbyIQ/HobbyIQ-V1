// Check TCA webhook status: recent events + registration + recent ingest
const { CosmosClient } = require("@azure/cosmos");
const https = require("https");

async function tcaFetch(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.thecardapi.com", port: 443, path, method: "GET",
      headers: { "x-market-api-key": process.env.TCA_API_KEY, Accept: "application/json" },
      timeout: 15000,
    }, (res) => {
      let d = ""; res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d.slice(0, 1200) }));
    });
    req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");

  console.log("=== 1) webhook_events recent activity ===");
  try {
    const wh = db.container("webhook_events");
    const q = await wh.items.query({
      query: `SELECT TOP 10 c.id, c.source, c.receivedAt, c.eventType, c.payload FROM c ORDER BY c.receivedAt DESC`,
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`  ${q.resources.length} recent event(s)`);
    for (const e of q.resources) {
      console.log(`  ${e.receivedAt}  src=${e.source} type=${e.eventType}`);
    }
    // Group by source in last 24h
    const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
    const q2 = await wh.items.query({
      query: `SELECT c.source, COUNT(1) AS n FROM c WHERE c.receivedAt >= @c GROUP BY c.source`,
      parameters: [{ name: "@c", value: cutoff }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`  last 24h by source:`);
    for (const r of q2.resources) console.log(`    ${r.source}: ${r.n}`);
  } catch (err) {
    console.warn(`  webhook_events read failed: ${err.message||err}`);
  }

  console.log("\n=== 2) TCA webhook registration ===");
  try {
    const res = await tcaFetch("/api/v1/market/webhook");
    console.log(`  HTTP ${res.status}`);
    console.log(`  body: ${res.body}`);
  } catch (err) {
    console.warn(`  fetch failed: ${err.message||err}`);
  }

  console.log("\n=== 3) recent tca-ebay ingest cadence (last 4h by hour) ===");
  const sold = db.container("sold_comps");
  const cutoff = new Date(Date.now() - 4*60*60*1000).toISOString();
  const q3 = await sold.items.query({
    query: `SELECT SUBSTRING(c.observedAt, 0, 13) AS hour, COUNT(1) AS n
            FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= @c
            GROUP BY SUBSTRING(c.observedAt, 0, 13)`,
    parameters: [{ name: "@c", value: cutoff }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of q3.resources.sort((a,b)=>a.hour.localeCompare(b.hour))) {
    console.log(`  ${r.hour}: ${r.n}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
