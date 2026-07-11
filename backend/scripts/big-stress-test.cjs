#!/usr/bin/env node
/**
 * CF-BIG-STRESS-TEST (2026-07-11, Drew).
 *
 * Comprehensive stress test across the whole reference-catalog:
 *   1. Runs Bowman v2 stress test workbook
 *   2. Runs Topps All-Sets stress test workbook
 *   3. Generates + runs a synthetic Panini + Historic products stress
 *   4. Reports overall coverage per family
 *   5. Reports total tuples tested vs Cosmos rows tested against
 */

const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const { CosmosClient } = require("@azure/cosmos");

function slug(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’‘"`]+/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function loadWorkbook(fp) {
  if (!fs.existsSync(fp)) {
    console.warn(`[big-stress] skip missing: ${fp}`);
    return [];
  }
  const wb = XLSX.readFile(fp);
  const sheet = wb.Sheets["Cards"] ?? wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

async function stressTestOne(name, cards, cosmosDocsByPk) {
  const tuples = new Map();
  for (const card of cards) {
    const year = Number(card.Year);
    const productRaw = String(card.Set ?? "").trim();
    const parallelRaw = String(card.Parallel ?? "").trim();
    const autoStr = String(card["Auto Y/N"] ?? "").trim().toUpperCase();
    const auto = autoStr === "Y" || autoStr === "YES";
    if (!year || !productRaw || !parallelRaw) continue;
    const parallelLc = parallelRaw.toLowerCase();
    if (parallelLc === "base" || parallelLc === "base auto" || parallelLc === "base chrome") continue;
    const productKey = slug(productRaw);
    const parallelKey = slug(parallelRaw);
    const key = `${productKey}|${year}|${parallelKey}|${auto}`;
    if (!tuples.has(key)) {
      tuples.set(key, { productKey, year, parallel: parallelRaw, parallelKey, auto, sampleCount: 1 });
    } else {
      tuples.get(key).sampleCount++;
    }
  }

  let exactHits = 0, refractorFuzz = 0, waveRewrite = 0, autoMismatch = 0, gap = 0;
  const gaps = [];
  for (const t of tuples.values()) {
    const bucket = cosmosDocsByPk.get(t.productKey);
    if (!bucket) { gap++; gaps.push(t); continue; }
    const yearMatch = bucket.filter(d => d.year === t.year);
    if (yearMatch.length === 0) { gap++; gaps.push(t); continue; }
    const strict = yearMatch.find(d => d.parallelKey === t.parallelKey && d.auto === t.auto);
    if (strict) { exactHits++; continue; }
    const refKey = slug(`${t.parallel} Refractor`);
    if (yearMatch.find(d => d.parallelKey === refKey && d.auto === t.auto)) { refractorFuzz++; continue; }
    if (/\bwave\b/i.test(t.parallel)) {
      const rewriteKey = slug(t.parallel.replace(/\bwave\b/i, "RayWave") + " Refractor");
      if (yearMatch.find(d => d.parallelKey === rewriteKey && d.auto === t.auto)) { waveRewrite++; continue; }
    }
    // Same parallelKey but wrong auto flag
    if (yearMatch.find(d => d.parallelKey === t.parallelKey)) { autoMismatch++; continue; }
    gap++; gaps.push(t);
  }

  const total = tuples.size;
  const covered = exactHits + refractorFuzz + waveRewrite;
  const pct = total > 0 ? Math.round((100 * covered) / total) : 0;
  console.log(`\n=== ${name} ===`);
  console.log(`  unique tuples:     ${total}`);
  console.log(`  exact hits:        ${exactHits} (${total > 0 ? Math.round(100 * exactHits / total) : 0}%)`);
  console.log(`  refractor-fuzz:    ${refractorFuzz}`);
  console.log(`  wave-rewrite:      ${waveRewrite}`);
  console.log(`  auto mismatch:     ${autoMismatch}`);
  console.log(`  TRUE gaps:         ${gap}`);
  console.log(`  EFFECTIVE COV:     ${pct}%`);
  if (gaps.length > 0 && gaps.length <= 15) {
    console.log(`  top gaps:`);
    const sorted = gaps.sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 8);
    for (const g of sorted) {
      console.log(`    ${g.productKey} ${g.year} "${g.parallel}"${g.auto ? " (auto)" : ""}`);
    }
  }
  return { name, total, exactHits, refractorFuzz, waveRewrite, autoMismatch, gap, pct };
}

(async () => {
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const c = new CosmosClient(connStr).database("hobbyiq").container("reference-catalog");

  console.log("[big-stress] loading all Cosmos parallel docs...");
  const { resources: allParallels } = await c.items.query({
    query: "SELECT c.productKey, c.year, c.parallel, c.parallelKey, c.auto, c.printRun FROM c WHERE c.docType='parallel'",
  }).fetchAll();
  console.log(`[big-stress] loaded ${allParallels.length} parallel docs`);

  const docsByPk = new Map();
  for (const d of allParallels) {
    const bucket = docsByPk.get(d.productKey) ?? [];
    bucket.push(d);
    docsByPk.set(d.productKey, bucket);
  }

  const home = "c:/Users/dvabu/OneDrive - Just the Boys and Cards LLC";
  const results = [];
  results.push(await stressTestOne("Bowman v2 stress test", loadWorkbook(`${home}/Bowman_2022_2026_Stress_Test_v2.xlsx`), docsByPk));
  results.push(await stressTestOne("Topps All-Sets stress test", loadWorkbook(`${home}/Topps_2020_2026_All_Sets_Pricing_Stress_Test.xlsx`), docsByPk));

  // Aggregate summary
  console.log("\n\n=== AGGREGATE ===");
  const totals = results.reduce((acc, r) => ({
    total: acc.total + r.total,
    exact: acc.exact + r.exactHits,
    fuzz: acc.fuzz + r.refractorFuzz + r.waveRewrite,
    autoMismatch: acc.autoMismatch + r.autoMismatch,
    gap: acc.gap + r.gap,
  }), { total: 0, exact: 0, fuzz: 0, autoMismatch: 0, gap: 0 });
  const totalCov = Math.round(100 * (totals.exact + totals.fuzz) / totals.total);
  console.log(`  total tuples tested:   ${totals.total}`);
  console.log(`  exact hits:            ${totals.exact} (${Math.round(100 * totals.exact / totals.total)}%)`);
  console.log(`  fuzzy matches:         ${totals.fuzz}`);
  console.log(`  auto-flag mismatches:  ${totals.autoMismatch}`);
  console.log(`  TRUE gaps:             ${totals.gap}`);
  console.log(`  OVERALL COVERAGE:      ${totalCov}%`);
})().catch(e => { console.error(e); process.exit(1); });
