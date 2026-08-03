const { CosmosClient } = require("@azure/cosmos");
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const catalog = c.database("hobbyiq").container("card_catalog");
  const sold = c.database("hobbyiq").container("sold_comps");
  
  console.log("=== CARD_CATALOG coverage ===");
  const ccBySource = await catalog.items.query({
    query: `SELECT c.source, COUNT(1) as n FROM c GROUP BY c.source`,
  }).fetchAll();
  for (const r of ccBySource.resources) console.log(`  source=${r.source}: ${r.n}`);
  
  const chDistinctCatalog = await catalog.items.query({
    query: `SELECT VALUE COUNT(1) FROM c WHERE c.source = 'cardhedge'`,
  }).fetchAll();
  console.log(`\nCH-source card_catalog rows: ${chDistinctCatalog.resources[0]}`);
  
  const ccBySport = await catalog.items.query({
    query: `SELECT c.sport, COUNT(1) as n FROM c WHERE c.source = 'cardhedge' GROUP BY c.sport`,
  }).fetchAll();
  console.log("CH catalog by sport:");
  for (const r of ccBySport.resources.sort((a,b)=>b.n-a.n)) console.log(`  ${r.sport || 'null'}: ${r.n}`);
  
  console.log("\n=== SOLD_COMPS coverage ===");
  const scBySource = await sold.items.query({
    query: `SELECT c.source, COUNT(1) as n FROM c GROUP BY c.source`,
  }).fetchAll();
  for (const r of scBySource.resources) console.log(`  source=${r.source || 'null'}: ${r.n}`);
  
  // Distinct cardIds with CH source in sold_comps (proxies for "cards we've observed")
  const chDistinctCardIds = await sold.items.query({
    query: `SELECT VALUE COUNT(1) FROM (SELECT DISTINCT c.cardId FROM c WHERE c.source = 'cardhedge')`,
  }).fetchAll();
  console.log(`\nDistinct CH cardIds in sold_comps: ${chDistinctCardIds.resources[0]}`);
  
  // Date range
  const dateRange = await sold.items.query({
    query: `SELECT VALUE { min: MIN(c.soldAt), max: MAX(c.soldAt) } FROM c WHERE c.source = 'cardhedge'`,
  }).fetchAll();
  console.log(`CH sales date range: ${JSON.stringify(dateRange.resources[0])}`);
  
  // By-year CH distribution to see if we have vintage
  console.log("\nCH sold_comps by cardYear (top 15):");
  const byYear = await sold.items.query({
    query: `SELECT c.cardYear as y, COUNT(1) as n FROM c WHERE c.source = 'cardhedge' AND IS_DEFINED(c.cardYear) GROUP BY c.cardYear`,
  }).fetchAll();
  const sortedYears = byYear.resources.sort((a,b)=>b.n-a.n).slice(0,15);
  for (const r of sortedYears) console.log(`  ${r.y}: ${r.n}`);
})();
