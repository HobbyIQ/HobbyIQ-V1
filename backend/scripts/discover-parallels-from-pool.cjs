#!/usr/bin/env node
// CF-DISCOVER-PARALLELS-FROM-POOL (Drew, 2026-08-01).
//
// Successor to discover-ch-parallels.cjs. Reads parallel-premium
// calibration from OUR unified sold_comps pool, not from CH's catalog.
// Aligned with the calibration doctrine
// ([[project-calibration-from-our-pool-only]]): every calibration
// constant derives from sold_comps grouped by identity fields — never
// keyed by vendor cardId, never enumerated from a vendor's catalog.
//
// For each (sport, year, setKey, isAuto) tuple:
//   base_median   = median price of rows where parallel = 'Base'
//   FOR EACH distinct parallel in this tuple:
//     premium = median price of parallel rows / base_median
//     n = number of comps at this parallel
//
// Output: JSON file with { tuple → { base: median, parallels: {name: {premium, n}} } }
// Callers read this the same way discover-ch-parallels.cjs's output
// is consumed, so downstream is unchanged.
//
// Vendor-agnostic — any parallel that exists in sold_comps gets a
// premium. Any new vendor's sales feed calibration automatically on
// the next run.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   OUTPUT_PATH                default backend/data/parallel-premiums-from-pool.json
//   MIN_BASE_COMPS             default 5   (base median needs this many to be stable)
//   MIN_PARALLEL_COMPS         default 2   (parallel premium needs this many)
//   FRESHNESS_DAYS             default 365 (only include comps from last N days)

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = process.env.OUTPUT_PATH || "backend/data/parallel-premiums-from-pool.json";
const MIN_BASE_COMPS = Math.max(1, Number(process.env.MIN_BASE_COMPS || 5));
const MIN_PARALLEL_COMPS = Math.max(1, Number(process.env.MIN_PARALLEL_COMPS || 2));
const FRESHNESS_DAYS = Math.max(1, Number(process.env.FRESHNESS_DAYS || 365));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[discover-parallels-from-pool] min-base=${MIN_BASE_COMPS} min-parallel=${MIN_PARALLEL_COMPS} freshness=${FRESHNESS_DAYS}d output=${OUTPUT_PATH}`);

  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 86_400_000).toISOString();

  // Aggregation buckets: (sport, year, setKey, isAuto) → { parallelName → prices[] }
  const buckets = new Map();
  const key = (sport, year, setKey, isAuto) => `${sport}|${year}|${setKey}|${isAuto ? "auto" : "no-auto"}`;

  console.log("Scanning sold_comps...");
  const query = "SELECT c.sport, c.cardYear, c.setName, c.parallel, c.isAuto, c.price, c.hobbyiqCardId " +
                "FROM c WHERE c.soldAt >= @from AND IS_DEFINED(c.hobbyiqCardId) AND c.price > 0";
  const iter = sc.items.query({ query, parameters: [{ name: "@from", value: cutoff }] }, { maxItemCount: 5000 });

  let scanned = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      const sport = r.sport;
      const year = Number(r.cardYear);
      const setKey = r.setName;
      const isAuto = r.isAuto === true;
      const parallel = String(r.parallel || "Base").trim() || "Base";
      const price = Number(r.price);
      if (!sport || !year || !setKey || !Number.isFinite(price) || price <= 0) continue;
      const k = key(sport, year, setKey, isAuto);
      let bucket = buckets.get(k);
      if (!bucket) { bucket = { parallels: new Map() }; buckets.set(k, bucket); }
      let arr = bucket.parallels.get(parallel);
      if (!arr) { arr = []; bucket.parallels.set(parallel, arr); }
      arr.push(price);
    }
    if (scanned % 100000 === 0) console.log(`  scanned=${scanned}  tuples=${buckets.size}`);
  }
  console.log(`  Scan done. scanned=${scanned}  tuples=${buckets.size}`);

  // Compute base medians + parallel premiums
  const output = {};
  let emitted = 0, skipNoBase = 0, skipThin = 0;
  for (const [k, bucket] of buckets) {
    const basePrices = bucket.parallels.get("Base") || [];
    if (basePrices.length < MIN_BASE_COMPS) { skipNoBase++; continue; }
    const baseMedian = median(basePrices);
    if (baseMedian === null || baseMedian <= 0) { skipNoBase++; continue; }
    const parallels = {};
    for (const [name, prices] of bucket.parallels) {
      if (name === "Base") continue;
      if (prices.length < MIN_PARALLEL_COMPS) { skipThin++; continue; }
      const m = median(prices);
      if (m === null || m <= 0) continue;
      parallels[name] = {
        premium: Math.round((m / baseMedian) * 100) / 100,
        n: prices.length,
        median: m,
      };
    }
    output[k] = {
      base: baseMedian,
      baseN: basePrices.length,
      parallels,
    };
    emitted++;
  }

  console.log(`\n=== Done ===`);
  console.log(`  tuples with base:   ${emitted}`);
  console.log(`  skipped (no base):  ${skipNoBase}`);
  console.log(`  parallels skipped (thin): ${skipThin}`);

  // Sample output for sanity check
  const sampleKeys = Object.keys(output).slice(0, 3);
  for (const k of sampleKeys) {
    const parCount = Object.keys(output[k].parallels).length;
    console.log(`  sample: ${k}  base=$${output[k].base}  parallels=${parCount}`);
  }

  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
