// CF-VERIFY-MATCH-FIRST (Drew, 2026-08-07). Answers: is the match-first
// ingest deployed today actually landing rows with catalog-consistent
// hobbyiqCardId slugs, vs continuing to free-mint garbage sport tags
// (F1/WWE as baseball, etc.)?
//
// Compares: post-deploy sport distribution + catalog-unmatched queue depth.

const { CosmosClient } = require("@azure/cosmos");

const POST_DEPLOY_ISO = "2026-08-07T22:22:30Z"; // ack-first deploy live time

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");
  const staging = c.database("hobbyiq").container("comps_staging");

  console.log(`=== POST-DEPLOY (${POST_DEPLOY_ISO}) TCA ROWS: sport distribution ===`);
  const bySport = await sc.items.query({
    query: "SELECT c.sport, COUNT(1) AS n FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= @cutoff GROUP BY c.sport",
    parameters: [{ name: "@cutoff", value: POST_DEPLOY_ISO }],
  }, { maxItemCount: -1 }).fetchAll();
  const total = bySport.resources.reduce((s, r) => s + (r.n || 0), 0);
  bySport.resources.sort((a, b) => (b.n || 0) - (a.n || 0)).forEach(r => {
    const pct = ((r.n || 0) / Math.max(total, 1) * 100).toFixed(1);
    console.log(`  ${String(r.sport || "(null)").padEnd(15)} ${String(r.n).padStart(6)}  ${pct}%`);
  });
  console.log(`  ${"TOTAL".padEnd(15)} ${String(total).padStart(6)}`);

  console.log(`\n=== POST-DEPLOY TCA ROWS: hobbyiqCardId sport-prefix distribution ===`);
  const byHiqSport = await sc.items.query({
    query: "SELECT SUBSTRING(c.hobbyiqCardId, 4, 15) AS hiqPrefix, COUNT(1) AS n FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= @cutoff GROUP BY SUBSTRING(c.hobbyiqCardId, 4, 15)",
    parameters: [{ name: "@cutoff", value: POST_DEPLOY_ISO }],
  }, { maxItemCount: -1 }).fetchAll();
  byHiqSport.resources.sort((a, b) => (b.n || 0) - (a.n || 0)).forEach(r => {
    console.log(`  hiq:${String(r.hiqPrefix || "(null)").padEnd(15)} ${r.n}`);
  });

  console.log(`\n=== 3 SAMPLE POST-DEPLOY TCA ROWS ===`);
  const samples = await sc.items.query({
    query: "SELECT TOP 3 c.title, c.sport, c.hobbyiqCardId, c.playerName FROM c WHERE c.source = 'tca-ebay' AND c.observedAt >= @cutoff",
    parameters: [{ name: "@cutoff", value: POST_DEPLOY_ISO }],
  }, { maxItemCount: 3 }).fetchAll();
  samples.resources.forEach((r, i) => {
    console.log(`  ${i + 1}. title=${(r.title || "").slice(0, 80)}`);
    console.log(`     sport=${r.sport} hiq=${(r.hobbyiqCardId || "").slice(0, 80)}`);
    console.log(`     player=${r.playerName}`);
  });

  console.log(`\n=== CATALOG-UNMATCHED STAGING QUEUE (comps_staging) ===`);
  try {
    const stagingTotal = await staging.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'catalog-unmatched'",
    }, { maxItemCount: 1 }).fetchAll();
    console.log(`  total catalog-unmatched rows: ${stagingTotal.resources[0] ?? 0}`);
    const stagingRecent = await staging.items.query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'catalog-unmatched' AND c.observedAt >= @cutoff",
      parameters: [{ name: "@cutoff", value: POST_DEPLOY_ISO }],
    }, { maxItemCount: 1 }).fetchAll();
    console.log(`  post-deploy catalog-unmatched: ${stagingRecent.resources[0] ?? 0}`);
  } catch (e) {
    console.log(`  (comps_staging query failed: ${e?.message ?? e})`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
