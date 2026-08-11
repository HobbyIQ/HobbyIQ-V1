// CF-CHECKLIST-DISCOVERY (Drew, 2026-08-10). Find product families with
// sold_comps activity but zero catalog coverage. Output = ordered
// backlog for the checklist ingest pipeline.
//
// Grouping key: (sport, year, setKey) — one row per distinct product.
// Metric: sold_comps row count (proxy for how impactful catalog
// coverage would be).
//
// Env: MAX_PRODUCTS to cap output (default 100)
//      MIN_ROWS: skip products with < N sold_comps (default 5, prunes long tail)

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 100);
const MIN_ROWS = Number(process.env.MIN_ROWS || 5);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const sold = db.container("sold_comps");
  const catalog = db.container("card_catalog");

  console.log("=== step 1: enumerate sold_comps products from hobbyiqCardId ===");
  // Cosmos SQL can't SUBSTRING-parse into GROUP BY nicely; do it JS-side
  // by streaming distinct hobbyiqCardIds + counts, then parse.
  const q1 = await sold.items.query({
    query: `SELECT c.hobbyiqCardId, COUNT(1) AS n
            FROM c
            WHERE IS_STRING(c.hobbyiqCardId)
            GROUP BY c.hobbyiqCardId`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  ${q1.resources.length} distinct slugs`);
  // Group by product family (sport:year:setKey)
  const byProduct = new Map();
  for (const r of q1.resources) {
    const parts = r.hobbyiqCardId.split(":");
    if (parts.length < 5 || parts[0] !== "hiq") continue;
    const sport = parts[1], year = Number(parts[2]), setKey = parts[3];
    if (!sport || !year || !setKey) continue;
    const key = `${sport}:${year}:${setKey}`;
    const cur = byProduct.get(key) ?? { sport, year, setKey, n: 0 };
    cur.n += r.n;
    byProduct.set(key, cur);
  }
  const products = [...byProduct.values()]
    .filter((r) => r.n >= MIN_ROWS)
    .sort((a, b) => b.n - a.n);
  console.log(`  ${products.length} product families (>= ${MIN_ROWS} rows)`);

  console.log(`\n=== step 2: check catalog coverage for each (top ${MAX_PRODUCTS}) ===`);
  const results = [];
  for (const p of products.slice(0, MAX_PRODUCTS)) {
    // Match catalog by prefix of hobbyiqCardId (avoid depending on
    // separate setKey field which may not be populated on every row)
    const prefix = `hiq:${p.sport}:${p.year}:${p.setKey}:`;
    const cq = await catalog.items.query({
      query: `SELECT VALUE COUNT(1) FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, @pfx)`,
      parameters: [{ name: "@pfx", value: prefix }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    const catalogRows = cq.resources[0] || 0;
    results.push({
      sport: p.sport, year: p.year, setKey: p.setKey,
      soldCompsRows: p.n, catalogRows,
      coverageRatio: catalogRows > 0 ? Math.round(catalogRows / p.n * 100) : 0,
      gap: p.n - catalogRows,
    });
  }
  results.sort((a, b) => b.gap - a.gap);

  console.log(`\n=== TOP ${MAX_PRODUCTS} products by gap (sold_comps - catalog) ===`);
  console.log(`  ${"sport".padEnd(12)} ${"year".padEnd(6)} ${"setKey".padEnd(40)} ${"comps".padStart(7)} ${"catalog".padStart(7)} ${"gap".padStart(7)}`);
  for (const r of results.slice(0, 60)) {
    console.log(`  ${r.sport.padEnd(12)} ${String(r.year).padEnd(6)} ${(r.setKey || "").padEnd(40)} ${String(r.soldCompsRows).padStart(7)} ${String(r.catalogRows).padStart(7)} ${String(r.gap).padStart(7)}`);
  }

  const zeroCatalog = results.filter((r) => r.catalogRows === 0);
  console.log(`\n  ${zeroCatalog.length} products have ZERO catalog coverage`);
  console.log(`  ${results.filter((r) => r.coverageRatio < 20).length} products have < 20% coverage`);

  const outPath = path.join(__dirname, "catalog-coverage-gap.json");
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), products: results }, null, 2));
  console.log(`\n  wrote ${outPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
