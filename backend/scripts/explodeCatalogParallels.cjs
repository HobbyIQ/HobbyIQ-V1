// CF-EXPLODE-CATALOG-PARALLELS-ACTUALS (Drew, 2026-08-11).
//
// Proactive parallel explosion using ACTUALS from
// backend/data/checklists/hand-fetched/parallels-*.json.
//
// (Old approach used synthetic parallel-templates.json — REJECTED per
// user: "no template, we need actuals".)
//
// For every catalog row with parallel="Base" whose (sport, year, setKey)
// has an actuals file, emit rows for every remaining parallel in that
// product's actuals — base vs prospect vs auto rainbow picked from the
// same file. Products without actuals are SKIPPED (no synthetic fill).
//
// Chrome prospect detection: setKey=bowman-chrome AND cardNumber starts
// with BCP → uses prospectParallels not baseParallels.
//
// Env:
//   APPLY=true             write (default dry-run)
//   CONCURRENCY=16
//   MAX_IDENTITIES=100000  cap for staged runs (default unlimited)
//   FAMILIES="a,b,c"       optional filter — only explode these families
//   YEAR_MIN=2015          skip pre-2015 products (they lack modern parallels)

const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "cardCatalog.service.js"));

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const MAX_IDENTITIES = Number(process.env.MAX_IDENTITIES || 0);
const FAMILIES = (process.env.FAMILIES || "").split(",").map(s => s.trim()).filter(Boolean);
const YEAR_MIN = Number(process.env.YEAR_MIN || 0);
// CF-EXPLODE-SHARDS (Drew, 2026-08-11). Split the base-identity scan
// across N disjoint workers. SHARD_INDEX picks which slice this worker
// handles (0..SHARD_TOTAL-1); SHARD_TOTAL is the divisor. Uses cardYear
// MOD for the split — deterministic + roughly uniform across the
// modern-catalog year distribution (2015+). Set both env vars to
// activate; leaving them unset (or SHARD_TOTAL=0) runs the whole set.
const SHARD_TOTAL = Number(process.env.SHARD_TOTAL || 0);
const SHARD_INDEX = Number(process.env.SHARD_INDEX || 0);

const HAND_FETCHED_DIR = path.resolve(__dirname, "..", "data", "checklists", "hand-fetched");

let PARALLELS_INDEX = null;
function loadParallelsIndex() {
  if (PARALLELS_INDEX) return PARALLELS_INDEX;
  PARALLELS_INDEX = new Map();
  if (!fs.existsSync(HAND_FETCHED_DIR)) return PARALLELS_INDEX;
  const files = fs.readdirSync(HAND_FETCHED_DIR).filter(f => f.startsWith("parallels-") && f.endsWith(".json"));
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(HAND_FETCHED_DIR, f), "utf8"));
      for (const applyStr of (doc.appliesTo || [])) {
        // Parse: "2025-panini-prizm-baseball" or "2026-bowman-chrome (proxy - 2026 TBA)"
        const clean = applyStr.replace(/\s*\(.*\)\s*$/, "").trim();
        PARALLELS_INDEX.set(clean, { file: f, doc });
      }
    } catch (e) { console.warn(`   skipping malformed ${f}: ${e.message}`); }
  }
  return PARALLELS_INDEX;
}

function isChromeProspect(setKey, cardNumber) {
  if (setKey !== "bowman-chrome" && setKey !== "bowman-mega" && setKey !== "bowman-chrome-sapphire") return false;
  return /^(?:bcp|cpa|bcpa|cra|tcpa)(?:-|\d)/i.test(String(cardNumber || ""));
}

function resolveActuals(sport, year, setKey, isAuto, cardNumber) {
  const idx = loadParallelsIndex();
  const keys = [
    `${year}-${setKey}-${sport}`,
    `${year}-${setKey}`,
  ];
  for (const k of keys) {
    const entry = idx.get(k);
    if (!entry) continue;
    const doc = entry.doc;
    let parallels;
    if (isAuto) parallels = doc.autoParallels;
    else if (isChromeProspect(setKey, cardNumber)) parallels = doc.prospectParallels || doc.baseParallels;
    else parallels = doc.baseParallels;
    if (parallels && parallels.length > 0) return { parallels, source: entry.file, key: k };
  }
  return null;
}

async function fetchWithRetry(iter, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { return await iter.fetchNext(); }
    catch (err) {
      if (err && err.code === 429) {
        const wait = (err.retryAfterInMs || 2000 * (i + 1)) + 500;
        if (i > 5) console.log(`  (429 backoff ${wait}ms, attempt ${i+1}/${tries})`);
        await new Promise(r => setTimeout(r, wait)); continue;
      }
      throw err;
    }
  }
  throw new Error("iter retries exhausted");
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const catalog = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  const idx = loadParallelsIndex();
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  cap=${MAX_IDENTITIES || "∞"}  families=${FAMILIES.join(",") || "(all)"}  yearMin=${YEAR_MIN}`);
  console.log(`  parallels-index: ${idx.size} product keys from ${new Set([...idx.values()].map(v => v.file)).size} files`);
  if (idx.size < 3) {
    console.warn(`  WARN: parallels index is nearly empty. Check backend/data/checklists/hand-fetched/parallels-*.json`);
  }

  // CF-YEAR-CARDYEAR-DUAL-READ (Drew, 2026-08-11). Legacy schema drift
  // — some rows carry `year`, others `cardYear`. Use IIF to normalize
  // in the filter so we don't miss either shape. Adley Rutschman 2023
  // Topps Chrome Titans CT-10 was invisible to prior scans because it
  // stored `year: 2023` with no `cardYear` field.
  const whereClauses = [
    "IS_STRING(c.hobbyiqCardId)",
    "STARTSWITH(c.hobbyiqCardId, 'hiq:')",
    "NOT IS_DEFINED(c.gradeTier)",
    "IS_DEFINED(c.sport)",
    "(IS_DEFINED(c.cardYear) OR IS_DEFINED(c.year))",
    "IS_DEFINED(c.setKey)",
    "IS_DEFINED(c.cardNumber)",
    "IS_DEFINED(c.playerName)",
    "(c.parallel = 'Base' OR c.parallel = 'base' OR NOT IS_DEFINED(c.parallel))",
  ];
  if (YEAR_MIN > 0) whereClauses.push(`IIF(IS_DEFINED(c.cardYear), c.cardYear, c.year) >= ${YEAR_MIN}`);
  if (SHARD_TOTAL > 0) whereClauses.push(`(IIF(IS_DEFINED(c.cardYear), c.cardYear, c.year) % ${SHARD_TOTAL}) = ${SHARD_INDEX}`);
  const q = `SELECT c.id, c.sport, c.cardYear, c.year, c.setKey, c.cardNumber, c.playerName, c.isAuto, c.parallel
             FROM c WHERE ${whereClauses.join(" AND ")}`;
  console.log(`  shard: index=${SHARD_INDEX} of total=${SHARD_TOTAL || "1 (unsharded)"}`);
  const iter = catalog.items.query({ query: q }, { maxItemCount: 500 });

  let scanned = 0, resolved = 0, skippedNoActuals = 0, skippedFilter = 0;
  let exploded = 0, wrote = 0, failed = 0;
  const t0 = Date.now();
  const inflight = [];
  const familyCounts = {};

  let batches = 0;
  while (iter.hasMoreResults()) {
    if (MAX_IDENTITIES && scanned >= MAX_IDENTITIES) break;
    const { resources } = await fetchWithRetry(iter);
    batches++;
    if (batches <= 3 || batches % 10 === 0) {
      const dur = ((Date.now() - t0)/1000).toFixed(0);
      console.log(`  batch=${batches} rows=${resources.length} scanned=${scanned.toLocaleString()} wrote=${wrote.toLocaleString()} ${dur}s`);
    }
    for (const r of resources) {
      if (MAX_IDENTITIES && scanned >= MAX_IDENTITIES) break;
      scanned++;
      if (FAMILIES.length > 0 && !FAMILIES.includes(r.setKey)) { skippedFilter++; continue; }
      // CF-YEAR-CARDYEAR-DUAL-READ (Drew, 2026-08-11). Coalesce so
      // downstream sees a single normalized year regardless of which
      // field the row was written with.
      const yr = r.cardYear ?? r.year;
      const hit = resolveActuals(r.sport, yr, r.setKey, Boolean(r.isAuto), r.cardNumber);
      if (!hit) { skippedNoActuals++; continue; }
      resolved++;
      const routeKey = `${r.setKey}${r.isAuto ? "-auto" : (isChromeProspect(r.setKey, r.cardNumber) ? "-prospect" : "-base")}→${hit.key}`;
      familyCounts[routeKey] = (familyCounts[routeKey] || 0) + 1;

      for (const par of hit.parallels) {
        if (par.name === "Base" || par.name === "base") continue; // skip base (already exists)
        exploded++;
        if (!APPLY) continue;
        const entry = deriveCatalogEntry({
          sport: r.sport, year: yr, setKey: r.setKey,
          cardNumber: r.cardNumber, parallel: par.name,
          isAuto: Boolean(r.isAuto), printRun: par.printRun,
          playerName: r.playerName,
          source: `catalog-explode-actuals-${new Date().toISOString().slice(0,10)}`,
          confidence: 0.85,
          vendorIds: {},
        });
        if (!entry) continue;
        const task = upsertCatalogEntry(entry)
          .then(() => { wrote++; })
          .catch((e) => { failed++; if (failed < 5) console.warn(`   fail: ${e.message||e}`); })
          .finally(() => {
            const i = inflight.indexOf(task);
            if (i >= 0) inflight.splice(i, 1);
          });
        inflight.push(task);
        if (inflight.length >= CONCURRENCY) await Promise.race(inflight);
      }

      if (scanned % 1000 === 0) {
        const dur = ((Date.now() - t0)/1000).toFixed(0);
        console.log(`   scanned=${scanned.toLocaleString()} resolved=${resolved.toLocaleString()} exploded=${exploded.toLocaleString()} wrote=${wrote.toLocaleString()} failed=${failed}  ${dur}s`);
      }
    }
  }
  await Promise.all(inflight);
  const dur = ((Date.now() - t0)/1000).toFixed(0);
  console.log(`\n[done ${dur}s]`);
  console.log(`  scanned:               ${scanned.toLocaleString()}`);
  console.log(`  resolved to actuals:   ${resolved.toLocaleString()}`);
  console.log(`  skipped (no actuals):  ${skippedNoActuals.toLocaleString()}`);
  console.log(`  skipped (filter):      ${skippedFilter.toLocaleString()}`);
  console.log(`  ${APPLY ? "wrote" : "would-write"}: ${exploded.toLocaleString()}`);
  if (APPLY) console.log(`  failed: ${failed}`);
  console.log("\ntop route counts:");
  const top = Object.entries(familyCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, v] of top) console.log(`  ${k}: ${v.toLocaleString()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
