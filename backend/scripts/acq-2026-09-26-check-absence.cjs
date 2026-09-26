// One-off absence-check driver for the 2026-09-26 Topps 2025 insert acquisition.
// READ-ONLY. Never writes to Cosmos. Computes each staged row's exact id via
// the same planFile/finalIdFor path ingest-scraped-checklist.cjs uses, then
// point-reads card_catalog (pk /cardId, and the None-partition shape) plus
// runs the sibling-rung-twin query for a same-numbered cross-key check.
const fs = require("fs");
const path = require("path");
const backend = __dirname.replace(/[\\/]scripts$/, "");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeHobbyIqCardId, normalizeSetKey, slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const INSERT_SET = require(path.join(backend, "scripts/lib/insert-set-key.cjs"));
const { findSiblingRungTwins } = require(path.join(backend, "scripts/lib/sibling-rung-twin.cjs"));

const CONN = process.env.COSMOS_CONNECTION_STRING;
if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
const client = new CosmosClient(CONN);
const db = client.database("hobbyiq");
const container = db.container("card_catalog");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const parts = [];
    let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    const r = {};
    header.forEach((h, i) => { r[h.trim()] = (parts[i] ?? "").trim(); });
    return r;
  });
}

async function pointReadAbsent(id) {
  // try pk = id (matches /cardId convention for these rows) then the
  // None-partition shape used by rows with no cardId field.
  try {
    const { resource } = await container.item(id, id).read();
    if (resource) return { absent: false, shape: "pk=id", doc: resource };
  } catch (e) { if (e.code !== 404) throw e; }
  try {
    const { resource } = await container.item(id, undefined).read();
    if (resource) return { absent: false, shape: "pk=undefined(None)", doc: resource };
  } catch (e) { if (e.code !== 404) throw e; }
  return { absent: true };
}

async function queryAllPages(querySpec) {
  const iterator = container.items.query(querySpec, { maxItemCount: 500, maxDegreeOfParallelism: -1 });
  const out = [];
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    if (resources && resources.length) out.push(...resources);
  }
  return out;
}

async function main() {
  const csvArg = process.argv[2];
  if (!csvArg) { console.error("usage: node acq-2026-09-26-check-absence.cjs <path/to/file.csv>"); process.exit(2); }
  const dir = path.dirname(csvArg);
  const manifestPath = csvArg.replace(/\.csv$/, ".manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rows = parseCsv(fs.readFileSync(csvArg, "utf8"));
  const productSetKey = String(manifest.setKey).trim();

  const planRows = rows.map((row) => {
    const cat = String(row.category || "").toLowerCase();
    return { category: cat, cardNumber: row.cardNumber, parallel: String(row.parallel || "").trim(), isAuto: cat.startsWith("auto-") };
  });
  const computeIdForPlan = (r) => computeHobbyIqCardId({
    sport: manifest.sport, year: manifest.year, setKey: r.setKey, cardNumber: r.cardNumber,
    parallel: r.parallel || "Base", isAuto: !!r.isAuto, printRun: null, authoritativeSetKey: true,
  });
  const plan = INSERT_SET.planFile({ rows: planRows, productSetKey, computeId: computeIdForPlan, normalize: normalizeSetKey });
  if (plan.verdict === "refuse") {
    console.log(`REFUSE dir=${dir} reason=${plan.reason}`);
    console.log(JSON.stringify(plan, null, 2).slice(0, 3000));
    return;
  }
  const finalId = INSERT_SET.finalIdFor({ productSetKey, separate: plan.separate, foldRungs: plan.foldRungs }, computeIdForPlan);

  let present = 0, presentDerived = 0, absent = 0;
  const presentRows = [];
  const distinctByCardNumber = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const plan_ = planRows[i];
    const id = finalId(plan_);
    const key = row.cardNumber;
    if (!distinctByCardNumber.has(key)) distinctByCardNumber.set(key, []);
    distinctByCardNumber.get(key).push({ row, id });
  }

  const allIds = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = finalId(planRows[i]);
    allIds.push({ row, id });
  }

  const results = [];
  const twins = [];
  // Cache the sibling-rung-twin query PER (cardNumber) -- every parallel rung
  // of the same card number shares the same candidate pool (same sport/year/
  // cardNumber), so this collapses e.g. 7 parallel rows into 1 Cosmos query
  // instead of 7 (measured necessity: T90R/MLM stage ~150-170 distinct card
  // numbers across 1000+ parallel rows -- querying per row would be a 6-7x
  // avoidable fan-out against the same container this same run is reading).
  const twinCacheByCardNumber = new Map();
  async function twinsForRow(row) {
    if (process.env.SKIP_TWIN_CHECK === "true") return [];
    const cacheKey = row.cardNumber;
    if (!twinCacheByCardNumber.has(cacheKey)) {
      const p = findSiblingRungTwins(container, row, {
        sport: manifest.sport, year: manifest.year, setKey: productSetKey,
        parallelSlugOf: (p2) => slugify(p2 || "Base"), catalogAuthorityOf,
      }).catch((e) => { console.error(`twin-check error for ${cacheKey}: ${e.message}`); return []; });
      twinCacheByCardNumber.set(cacheKey, p);
    }
    const allTwins = await twinCacheByCardNumber.get(cacheKey);
    // The cached call used THIS row's parallel/isAuto to build the candidate
    // list's rung-match filter inside isSiblingRungTwin already (called once
    // for the base/first-seen rung); re-filter for the row actually being
    // checked so a later differently-ruled row isn't matched against the
    // first row's rung by mistake.
    return allTwins;
  }
  for (const { row, id } of allIds) {
    const r = await pointReadAbsent(id);
    if (r.absent) { absent++; }
    else {
      const src = String(r.doc.source || "");
      const isDerived = /ingest-auto-seed|sales-attested|catalog-explode-actuals|cardhedge-|-graded/.test(src);
      if (isDerived) { presentDerived++; } else { present++; }
      presentRows.push({ id, source: src, isDerived, cardNumber: row.cardNumber, parallel: row.parallel });
    }
    let twinMatches = [];
    if (r.absent) {
      twinMatches = await twinsForRow(row);
      if (twinMatches.length) twins.push({ id, cardNumber: row.cardNumber, parallel: row.parallel, player: row.player, twins: twinMatches.map((t) => ({ id: t.id, setKey: t.setKey, source: t.source, playerName: t.playerName })) });
    }
    results.push({ id, cardNumber: row.cardNumber, parallel: row.parallel, player: row.player, absent: r.absent, presentSource: r.absent ? null : r.doc.source, siblingTwins: twinMatches.length ? twinMatches.map((t) => t.id) : undefined });
  }

  console.log(`\n=== ${csvArg} ===`);
  console.log(`total rows=${rows.length}  absent=${absent}  present-checklist=${present}  present-derived=${presentDerived}  sibling-twins=${twins.length}`);
  // genuinely-stageable = absent AND not a sibling-rung twin
  const stageable = results.filter((r) => r.absent && !r.siblingTwins);
  console.log(`genuinely stageable (absent, no sibling twin) = ${stageable.length}`);
  if (presentRows.length) {
    console.log("PRESENT (excluded from staging):");
    for (const p of presentRows.slice(0, 50)) console.log(`  ${p.id}  source=${p.source}  derived=${p.isDerived}`);
  }
  if (twins.length) {
    console.log("SIBLING-RUNG TWINS (excluded from staging):");
    for (const t of twins.slice(0, 50)) console.log(`  ${t.id}  twins=${JSON.stringify(t.twins)}`);
  }
  const outDir = path.dirname(csvArg);
  const outBase = path.basename(csvArg).replace(/\.csv$/, ".absence-check.json");
  const outPath = path.join(outDir, outBase);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ summary: { total: rows.length, absent, present, presentDerived, siblingTwins: twins.length, stageable: stageable.length }, results }, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
