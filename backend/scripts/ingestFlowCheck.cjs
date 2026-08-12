// Snapshot of ingestion → mapping flow over last 24h and 7d.
// Confirms: every source's fresh rows land in sold_comps AND carry
// hobbyiqCardId (the join key to card_catalog). Also breaks out the
// staging container to see what's queued but not yet promoted.
const { CosmosClient } = require("@azure/cosmos");

async function count(container, where, name) {
  try {
    const { resources } = await container.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
    }, { enableCrossPartitionQuery: true }).fetchAll();
    return resources[0] || 0;
  } catch (e) {
    console.warn(`  ${name} query failed: ${e?.code || e?.message}`);
    return null;
  }
}

async function groupCount(container, where, groupBy) {
  try {
    const { resources } = await container.items.query({
      // Cross-partition GROUP BY doesn't support ORDER BY reliably. Sort in JS.
      query: `SELECT ${groupBy} AS bucket, COUNT(1) AS n FROM c WHERE ${where} GROUP BY ${groupBy}`,
    }, { enableCrossPartitionQuery: true }).fetchAll();
    return resources.sort((a, b) => b.n - a.n);
  } catch (e) {
    console.warn(`  groupCount failed: ${e?.code || e?.message}`);
    return [];
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");
  const sc = db.container("sold_comps");
  const stg = db.container("comps_staging");
  const cat = db.container("card_catalog");

  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff7d  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString();

  // Use soldAt (immutable sale date) — c._ts is mutated by every PATCH
  // (backfills, dedups) so it's useless for "fresh ingestion" filtering.
  console.log("=== sold_comps by sale date (last 24h) ===");
  const total24h = await count(sc, `c.soldAt >= "${cutoff24h}"`, "total24h");
  console.log(`  sales with soldAt in last 24h:  ${total24h}`);
  const withHiq24h = await count(sc, `c.soldAt >= "${cutoff24h}" AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''`, "withHiq24h");
  console.log(`  with hobbyiqCardId:             ${withHiq24h}`);
  const missing24h = total24h - withHiq24h;
  console.log(`  MISSING hobbyiqCardId:          ${missing24h}`);

  console.log("\n=== sold_comps by source (last 24h by soldAt) ===");
  const bySource24h = await groupCount(sc, `c.soldAt >= "${cutoff24h}"`, "c.source");
  for (const r of bySource24h) console.log(`  ${(r.bucket || 'null').padEnd(20)} ${r.n}`);

  console.log("\n=== sold_comps by source (last 7d by soldAt) ===");
  const bySource7d = await groupCount(sc, `c.soldAt >= "${cutoff7d}"`, "c.source");
  for (const r of bySource7d) console.log(`  ${(r.bucket || 'null').padEnd(20)} ${r.n}`);

  console.log("\n=== comps_staging status snapshot ===");
  const stgTotal = await count(stg, "true", "stgTotal");
  console.log(`  total in staging:               ${stgTotal}`);
  const stgByStatus = await groupCount(stg, "true", "c.status");
  for (const r of stgByStatus) console.log(`  ${(r.bucket || 'null').padEnd(20)} ${r.n}`);

  console.log("\n=== staging fresh in last 24h ===");
  const stgFresh24h = await count(stg, `c._ts >= ${Math.floor(new Date(cutoff24h).getTime() / 1000)}`, "stgFresh24h");
  console.log(`  new to staging (24h):           ${stgFresh24h}`);

  console.log("\n=== card_catalog growth (last 24h) ===");
  const catFresh24h = await count(cat, `c._ts >= ${Math.floor(new Date(cutoff24h).getTime() / 1000)}`, "catFresh24h");
  console.log(`  new catalog entries (24h):      ${catFresh24h}`);
  const catFreshWithHiq24h = await count(cat, `c._ts >= ${Math.floor(new Date(cutoff24h).getTime() / 1000)} AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null`, "catFreshWithHiq24h");
  console.log(`  new WITH hobbyiqCardId:         ${catFreshWithHiq24h}`);

  console.log("\n=== ch_daily_sales (CH nightly ingest source) ===");
  try {
    const ch = db.container("ch_daily_sales");
    const chFresh24h = await count(ch, `c._ts >= ${Math.floor(new Date(cutoff24h).getTime() / 1000)}`, "chFresh24h");
    console.log(`  CH daily rows ingested (24h):   ${chFresh24h}`);
  } catch (e) {
    console.log(`  (ch_daily_sales unavailable: ${e?.message})`);
  }
}

main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
