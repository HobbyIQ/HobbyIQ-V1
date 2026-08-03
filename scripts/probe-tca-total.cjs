const { CosmosClient } = require("@azure/cosmos");
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database("hobbyiq");
  const sold = db.container("sold_comps");
  const staging = db.container("comps_staging");
  const state = db.container("crawl_state");

  console.log("=== sold_comps by source ===");
  const bySource = await sold.items.query({ query: `SELECT c.source, COUNT(1) as n FROM c GROUP BY c.source` }).fetchAll();
  for (const r of bySource.resources.sort((a,b)=>b.n-a.n)) console.log(`  ${r.source || 'null'}: ${r.n.toLocaleString()}`);

  console.log("\n=== tca-ebay in sold_comps ===");
  const t = await sold.items.query({ query: `SELECT VALUE COUNT(1) FROM c WHERE c.source = 'tca-ebay'` }).fetchAll();
  console.log(`  total: ${t.resources[0].toLocaleString()}`);
  const withSlug = await sold.items.query({ query: `SELECT VALUE COUNT(1) FROM c WHERE c.source = 'tca-ebay' AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null` }).fetchAll();
  console.log(`  with hobbyiqCardId: ${withSlug.resources[0].toLocaleString()}`);

  console.log("\n=== tca-ebay in comps_staging (immutable landing) ===");
  const s = await staging.items.query({ query: `SELECT VALUE COUNT(1) FROM c WHERE c.raw.vendor = 'tca-ebay'` }).fetchAll();
  console.log(`  total: ${s.resources[0].toLocaleString()}`);

  console.log("\n=== crawl_state ===");
  const states = await state.items.query({ query: "SELECT * FROM c" }).fetchAll();
  for (const s of states.resources) console.log(`  id=${s.id} totalRowsWritten=${(s.totalRowsWritten||0).toLocaleString()} lastRunAt=${s.lastRunAt}`);
  
  console.log("\n=== sample high-value tca-ebay landings ===");
  const hv = await sold.items.query({ query: `SELECT TOP 8 c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.gradeCompany, c.gradeValue, c.price, c.soldAt FROM c WHERE c.source = 'tca-ebay' AND c.price >= 500 ORDER BY c.price DESC` }).fetchAll();
  for (const r of hv.resources) {
    console.log(`  $${r.price.toLocaleString()} ${r.gradeCompany||''} ${r.gradeValue||''} — ${r.playerName} ${r.cardYear} ${r.setName} #${r.cardNumber} ${r.parallel||''}`);
  }
})();
