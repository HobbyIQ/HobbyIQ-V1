// Inspect parallel values on the consolidated 1991 Score #396 pool
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const sold = db.container("sold_comps");

  const slug = "hiq:baseball:1991:score:396:base:no-auto";
  const q = await sold.items.query({
    query: `SELECT c.title, c.parallel, c.gradeCompany, c.gradeValue, c.price FROM c WHERE c.hobbyiqCardId = @s ORDER BY c.soldAt DESC`,
    parameters: [{ name: "@s", value: slug }],
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`[${slug}] n=${q.resources.length}`);
  // group by parallel
  const byParallel = {};
  for (const r of q.resources) {
    const p = r.parallel ?? "(null)";
    byParallel[p] = (byParallel[p]||0)+1;
  }
  console.log("\nparallel value distribution:");
  for (const [p,c] of Object.entries(byParallel)) console.log(`  "${p}": ${c}`);

  // show all graded ones with their parallel
  const graded = q.resources.filter(r => r.gradeCompany && r.gradeCompany !== "Raw");
  console.log(`\ngraded rows (n=${graded.length}):`);
  for (const r of graded) {
    console.log(`  ${r.gradeCompany} ${r.gradeValue}  parallel="${r.parallel}"  $${r.price}  title="${(r.title||"").slice(0,80)}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
