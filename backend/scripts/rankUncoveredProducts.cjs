// CF-RANK-UNCOVERED-PRODUCTS (Drew, 2026-08-11). Enumerate (sport,year,
// setKey) triplets in card_catalog base-identities that have NO
// parallels file in hand-fetched/. Ranked by identity count so we know
// which products to fetch parallels for first.

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const HAND_FETCHED_DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");

// Load parallels index (mirror of explodeCatalogParallels.cjs)
function loadCoveredKeys() {
  const covered = new Set();
  const files = fs.readdirSync(HAND_FETCHED_DIR).filter(f => f.startsWith("parallels-") && f.endsWith(".json"));
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(HAND_FETCHED_DIR, f), "utf8"));
      for (const applyStr of (doc.appliesTo || [])) {
        const clean = applyStr.replace(/\s*\(.*\)\s*$/, "").trim();
        covered.add(clean);
      }
    } catch {}
  }
  return covered;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  const covered = loadCoveredKeys();
  console.log(`▸ ${covered.size} product keys already covered by parallels files`);

  // Group all base identities 2015+ by (sport, year, setKey)
  const buckets = new Map();
  const iter = c.items.query({
    query: `SELECT c.sport, c.cardYear, c.setKey FROM c
            WHERE NOT IS_DEFINED(c.gradeTier)
              AND IS_DEFINED(c.sport) AND IS_DEFINED(c.cardYear) AND IS_DEFINED(c.setKey)
              AND c.cardYear >= 2015
              AND (c.parallel = 'Base' OR c.parallel = 'base' OR NOT IS_DEFINED(c.parallel))`,
  }, { maxItemCount: 1000 });

  async function fetchWithRetry(tries = 15) {
    for (let i = 0; i < tries; i++) {
      try { return await iter.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) { await new Promise(r => setTimeout(r, (err.retryAfterInMs || 2000*(i+1)) + 500)); continue; }
        throw err;
      }
    }
    throw new Error("retries exhausted");
  }

  let scanned = 0;
  const t0 = Date.now();
  while (iter.hasMoreResults()) {
    const { resources } = await fetchWithRetry();
    for (const r of resources) {
      scanned++;
      const key = `${r.cardYear}|${r.setKey}|${r.sport}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    if (scanned % 50000 === 0) {
      console.log(`   scanned ${scanned.toLocaleString()}  distinct products=${buckets.size.toLocaleString()}  ${((Date.now()-t0)/1000).toFixed(0)}s`);
    }
  }
  console.log(`\n[scan done ${((Date.now()-t0)/1000).toFixed(0)}s] scanned=${scanned.toLocaleString()}  distinct products=${buckets.size.toLocaleString()}`);

  // Split by covered vs uncovered
  const uncovered = [];
  let coveredIdentities = 0;
  for (const [k, count] of buckets) {
    const [year, setKey, sport] = k.split("|");
    const covKeys = [`${year}-${setKey}-${sport}`, `${year}-${setKey}`];
    const isCovered = covKeys.some(x => covered.has(x));
    if (isCovered) coveredIdentities += count;
    else uncovered.push({ sport, year: Number(year), setKey, count });
  }
  uncovered.sort((a, b) => b.count - a.count);
  const uncoveredTotal = uncovered.reduce((s, x) => s + x.count, 0);

  console.log(`\ncoverage: ${coveredIdentities.toLocaleString()} identities covered by parallels files`);
  console.log(`gap:      ${uncoveredTotal.toLocaleString()} identities in ${uncovered.length} products WITHOUT parallels files`);

  const OUT = process.env.OUT || "C:/tmp/uncovered-products.json";
  fs.writeFileSync(OUT, JSON.stringify(uncovered, null, 2));
  console.log(`\nwrote ${uncovered.length} uncovered products to ${OUT}`);

  console.log(`\nTop 30 uncovered by identity count:`);
  console.log("  n    year  sport      setKey");
  for (const r of uncovered.slice(0, 30)) {
    console.log(`  ${String(r.count).padStart(5)}  ${r.year}  ${r.sport.padEnd(10)} ${r.setKey}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
