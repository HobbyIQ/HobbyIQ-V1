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

  console.log("=== step 1: page through sold_comps + aggregate JS-side ===");
  // Paginate to avoid fetchAll() burning RU on a 4M-row GROUP BY.
  // Small page size, count per page, aggregate in-memory.
  const q1 = sold.items.query({
    query: `SELECT c.hobbyiqCardId FROM c WHERE IS_STRING(c.hobbyiqCardId)`,
  }, { maxItemCount: 500 });
  const byProduct = new Map();
  let scanned = 0;
  const startedAt = Date.now();
  async function fetchNextWithRetry(tries = 5) {
    for (let i = 0; i < tries; i++) {
      try { return await q1.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error("fetchNext retries exhausted");
  }
  while (q1.hasMoreResults()) {
    const { resources } = await fetchNextWithRetry();
    for (const r of resources) {
      scanned++;
      const parts = r.hobbyiqCardId.split(":");
      if (parts.length < 5 || parts[0] !== "hiq") continue;
      const sport = parts[1], year = Number(parts[2]), setKey = parts[3];
      if (!sport || !year || !setKey) continue;
      const key = `${sport}:${year}:${setKey}`;
      const cur = byProduct.get(key) ?? { sport, year, setKey, n: 0 };
      cur.n += 1;
      byProduct.set(key, cur);
    }
    if (scanned % 100000 === 0) {
      const dur = ((Date.now() - startedAt)/1000).toFixed(0);
      console.log(`  scanned ${scanned.toLocaleString()} rows, ${byProduct.size} distinct products so far  ${dur}s`);
    }
  }
  const products = [...byProduct.values()]
    .filter((r) => r.n >= MIN_ROWS)
    .sort((a, b) => b.n - a.n);
  console.log(`  ${products.length} product families (>= ${MIN_ROWS} rows) from ${scanned.toLocaleString()} scanned`);

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
