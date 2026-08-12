// CF-RANK-PRODUCTS-BY-COMPS (Drew, 2026-08-11). Enumerate (sport, year,
// setKey) triplets in sold_comps by count. Feeds Part B: systematically
// fetch actual parallels for the top-N products by comp volume.
//
// Env: TOP=50 (default), OUT=path (default scratchpad/top-products.json)

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const TOP = Number(process.env.TOP || 50);
const OUT = process.env.OUT || path.join(process.env.TEMP || "/tmp", "top-products.json");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ranking products by sold_comps count  top=${TOP}`);

  // Group by parsing hobbyiqCardId slug prefix; slug shape: hiq:sport:year:setKey:cardNumber:parallel:auto:num-N
  const buckets = new Map();
  const iter = sold.items.query({
    query: `SELECT c.hobbyiqCardId FROM c WHERE IS_STRING(c.hobbyiqCardId) AND STARTSWITH(c.hobbyiqCardId, 'hiq:')`,
  }, { maxItemCount: 1000 });

  let scanned = 0;
  const t0 = Date.now();
  async function fetchWithRetry(tries = 5) {
    for (let i = 0; i < tries; i++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
          await new Promise(r => setTimeout(r, wait)); continue;
        }
        throw err;
      }
    }
    throw new Error("retries exhausted");
  }

  while (iter.hasMoreResults()) {
    const { resources } = await fetchWithRetry();
    for (const r of resources) {
      scanned++;
      const parts = r.hobbyiqCardId.split(":");
      if (parts.length < 5) continue;
      const key = `${parts[1]}|${parts[2]}|${parts[3]}`; // sport|year|setKey
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    if (scanned % 200000 === 0) {
      const dur = ((Date.now()-t0)/1000).toFixed(0);
      console.log(`   scanned=${scanned.toLocaleString()}  products=${buckets.size.toLocaleString()}  ${dur}s`);
    }
  }

  const ranked = [...buckets.entries()]
    .map(([k, count]) => {
      const [sport, year, setKey] = k.split("|");
      return { sport, year: Number(year), setKey, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP);

  fs.writeFileSync(OUT, JSON.stringify(ranked, null, 2));
  console.log(`\n[done] scanned=${scanned.toLocaleString()}  distinct-products=${buckets.size.toLocaleString()}`);
  console.log(`  wrote top-${TOP} to ${OUT}`);
  console.log(`\nTop 20:`);
  for (const [i, r] of ranked.slice(0, 20).entries()) {
    console.log(`  ${String(i+1).padStart(2)}. ${r.year} ${r.sport} ${r.setKey.padEnd(30)} ${r.count.toLocaleString().padStart(8)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
