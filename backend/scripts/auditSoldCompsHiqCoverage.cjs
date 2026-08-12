// Audit sold_comps hobbyiqCardId coverage. If most rows carry the slug,
// the catalog-as-hub design is already live and we just need to backfill
// the remainder. Also counts rows with a non-slug vendor cardId (legacy
// bubble.io IDs) so we know the sprawl size.
const { CosmosClient } = require("@azure/cosmos");

async function count(container, where) {
  const q = { query: `SELECT VALUE COUNT(1) FROM c WHERE ${where}` };
  const { resources } = await container.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
  return resources[0] || 0;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database("hobbyiq").container("sold_comps");
  const cat = client.database("hobbyiq").container("card_catalog");

  console.log("sold_comps coverage:");
  console.log("  total rows          :", await count(sc, "true"));
  console.log("  hobbyiqCardId set   :", await count(sc, "IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''"));
  console.log("  hobbyiqCardId NULL  :", await count(sc, "NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = ''"));
  console.log("  cardId starts hiq:  :", await count(sc, "IS_DEFINED(c.cardId) AND STARTSWITH(c.cardId, 'hiq:')"));
  console.log("  cardId non-hiq      :", await count(sc, "IS_DEFINED(c.cardId) AND NOT STARTSWITH(c.cardId, 'hiq:')"));

  console.log("\ncard_catalog:");
  console.log("  total entries       :", await count(cat, "true"));
  console.log("  hobbyiqCardId set   :", await count(cat, "IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''"));

  // Sample: which slugs have the most comps? confirms the join is dense
  const { resources: top } = await sc.items.query({
    query: "SELECT TOP 5 c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c WHERE IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null GROUP BY c.hobbyiqCardId ORDER BY COUNT(1) DESC",
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log("\nTop 5 slugs by comp count (proves aggregation works):");
  for (const r of top) console.log(`  ${r.n.toString().padStart(6)}  ${r.slug}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
