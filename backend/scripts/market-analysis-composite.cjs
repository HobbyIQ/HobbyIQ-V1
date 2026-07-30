#!/usr/bin/env node
// CF-MARKET-ANALYSIS-COMPOSITE (Drew, 2026-07-30). Market-wide trend
// report grouped by composite axes (color / edition / finish /
// insertSet / autoStyle / sport / product). For each group reports:
//
//   30d volume            (count of sales in trailing 30 days)
//   prior-30d volume      (sales in the 30d before that)
//   volume momentum       (30d / prior-30d) - 1
//   30d median price
//   prior-30d median      (compares to detect price momentum)
//   price momentum        (median this / median prior) - 1
//
// Uses composite fields when available; falls back to parsing the
// legacy `parallel` string for rows without composite yet.
//
// Env:
//   COSMOS_CONNECTION_STRING  — required
//   ANALYSIS_LIMIT=500000     — max rows scanned per pass
//   ANALYSIS_WINDOW_DAYS=30   — rolling window (defaults 30)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const LIMIT = Number(process.env.ANALYSIS_LIMIT || "500000");
const WINDOW_DAYS = Number(process.env.ANALYSIS_WINDOW_DAYS || "30");

async function fetchRecentSales(sc, sinceMs) {
  const sinceIso = new Date(sinceMs).toISOString();
  // Broad fetch: all sales since sinceMs with a price + soldAt.
  const query = `
    SELECT TOP @n
      c.id, c.soldAt, c.price, c.sport, c.isAuto, c.autoStyle, c.parallel,
      c.gradeCompany, c.gradeValue, c.printRun, c.cardYear, c.hobbyiqCardId,
      c.composite
    FROM c
    WHERE c.soldAt >= @since
      AND c.price > 0
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }, { name: "@since", value: sinceIso }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    if (rows.length % 25000 < 5000) process.stdout.write(`\r  fetching ${rows.length}`);
  }
  console.log(`\r  ${rows.length} sales since ${sinceIso}                     `);
  return rows;
}

function classifyRow(r) {
  const comp = r.composite;
  return {
    sport: (r.sport || "unknown").toLowerCase(),
    edition: comp?.edition ?? null,
    colorFamily: comp?.colorFamily ?? classifyLegacyColor(r.parallel),
    finishModifier: comp?.finishModifier ?? classifyLegacyFinish(r.parallel),
    insertSet: comp?.insertSet ?? null,
    isAuto: r.isAuto === true,
    autoStyle: r.autoStyle ?? null,
    printRun: r.printRun ?? null,
    gradeCompany: r.gradeCompany ?? null,
    gradeValue: r.gradeValue ?? null,
    product: extractProduct(r.hobbyiqCardId),
  };
}

// Legacy color classifier — parses `parallel` string when composite is null.
function classifyLegacyColor(parallel) {
  if (!parallel || typeof parallel !== "string") return null;
  const p = parallel.toLowerCase();
  if (/superfractor/.test(p)) return "SUPERFRACTOR";
  if (/platinum/.test(p)) return "PLATINUM";
  if (/x-?fractor/.test(p)) return "XFRACTOR";
  if (/rainbow foil/.test(p)) return "RAINBOW_FOIL";
  if (/prism/.test(p)) return "PRISM";
  if (/sepia/.test(p)) return "SEPIA";
  if (/negative/.test(p)) return "NEGATIVE";
  if (/speckle/.test(p)) return "SPECKLE";
  if (/mojo/.test(p)) return "MOJO";
  const colors = ["black","blue","red","green","gold","orange","purple","yellow","aqua","pink","silver"];
  for (const c of colors) if (new RegExp(`\\b${c}\\b`).test(p)) return c.toUpperCase();
  if (/refractor/.test(p)) return "REFRACTOR";
  if (/base/.test(p) || p === "") return "BASE";
  return null;
}

function classifyLegacyFinish(parallel) {
  if (!parallel || typeof parallel !== "string") return null;
  const p = parallel.toLowerCase();
  if (/ray[\s-]?wave/.test(p)) return "RAYWAVE";
  if (/wave/.test(p)) return "WAVE";
  if (/shimmer/.test(p)) return "SHIMMER";
  if (/lava/.test(p)) return "LAVA";
  if (/vinyl/.test(p)) return "VINYL";
  if (/prism/.test(p)) return "PRISM";
  if (/mini[\s-]?diamond/.test(p)) return "MINI_DIAMOND";
  if (/geometric/.test(p)) return "GEOMETRIC";
  return null;
}

function extractProduct(slug) {
  if (!slug) return null;
  const parts = String(slug).split(":");
  return parts[3] ?? null;
}

// Median with numeric-array short-circuit.
function median(arr) {
  if (arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Group rows by a key function; returns { key: [prices], key: [prices] }.
function groupByKey(rows, keyFn) {
  const groups = {};
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!groups[k]) groups[k] = [];
    groups[k].push(Number(r.price));
  }
  return groups;
}

function reportGroup(name, currGroups, priorGroups, opts = {}) {
  const minVolume = opts.minVolume ?? 20;
  const rows = [];
  const allKeys = new Set([...Object.keys(currGroups), ...Object.keys(priorGroups)]);
  for (const k of allKeys) {
    const curr = currGroups[k] ?? [];
    const prior = priorGroups[k] ?? [];
    if (curr.length + prior.length < minVolume) continue;
    const currMed = median(curr);
    const priorMed = median(prior);
    const volMomentum = prior.length > 0 ? (curr.length / prior.length - 1) : null;
    const priceMomentum = (currMed != null && priorMed != null && priorMed > 0)
      ? (currMed / priorMed - 1) : null;
    rows.push({ k, currN: curr.length, priorN: prior.length, currMed, priorMed, volMomentum, priceMomentum });
  }
  rows.sort((a, b) => b.currN - a.currN);
  console.log(`\n═══ ${name} (top 25 by volume, min ${minVolume}) ═══`);
  console.log(`   Key                          curr30d  prior30d  volMom   currMed  priorMed  priceMom`);
  rows.slice(0, 25).forEach(r => {
    const fmt = (n) => n == null ? "  n/a" : (n >= 0 ? "+" : "") + (n*100).toFixed(1) + "%";
    const fmtP = (n) => n == null ? "   n/a" : "$" + n.toFixed(2).padStart(6);
    console.log(`  ${String(r.k).padEnd(30)}  ${String(r.currN).padStart(6)}  ${String(r.priorN).padStart(7)}  ${fmt(r.volMomentum).padStart(6)}  ${fmtP(r.currMed)}  ${fmtP(r.priorMed)}  ${fmt(r.priceMomentum).padStart(6)}`);
  });
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  const now = Date.now();
  const priorStart = now - 2 * WINDOW_DAYS * 86400000;
  console.log(`[market-analysis-composite]`);
  console.log(`  window: ${WINDOW_DAYS} days`);
  console.log(`  compares last ${WINDOW_DAYS}d against prior ${WINDOW_DAYS}d\n`);

  const rows = await fetchRecentSales(sc, priorStart);
  const currStart = now - WINDOW_DAYS * 86400000;
  const curr = rows.filter(r => new Date(r.soldAt).getTime() >= currStart);
  const prior = rows.filter(r => new Date(r.soldAt).getTime() < currStart);
  console.log(`\n  Current ${WINDOW_DAYS}d: ${curr.length} sales`);
  console.log(`  Prior ${WINDOW_DAYS}d:   ${prior.length} sales\n`);

  const enrichCurr = curr.map(r => ({ ...r, cls: classifyRow(r) }));
  const enrichPrior = prior.map(r => ({ ...r, cls: classifyRow(r) }));

  // 1. Color family — the biggest single axis
  reportGroup("COLOR FAMILY",
    groupByKey(enrichCurr, r => r.cls.colorFamily),
    groupByKey(enrichPrior, r => r.cls.colorFamily),
    { minVolume: 30 });

  // 2. Edition — Sapphire, Mega Box, First Edition, Cosmic, Sonic, Lite
  reportGroup("EDITION",
    groupByKey(enrichCurr, r => r.cls.edition),
    groupByKey(enrichPrior, r => r.cls.edition),
    { minVolume: 10 });

  // 3. Finish modifier — WAVE, SHIMMER, VINYL, SPECKLE, RAYWAVE, etc.
  reportGroup("FINISH MODIFIER",
    groupByKey(enrichCurr, r => r.cls.finishModifier),
    groupByKey(enrichPrior, r => r.cls.finishModifier),
    { minVolume: 10 });

  // 4. Insert set
  reportGroup("INSERT SET",
    groupByKey(enrichCurr, r => r.cls.insertSet),
    groupByKey(enrichPrior, r => r.cls.insertSet),
    { minVolume: 5 });

  // 5. Sport
  reportGroup("SPORT",
    groupByKey(enrichCurr, r => r.cls.sport),
    groupByKey(enrichPrior, r => r.cls.sport),
    { minVolume: 100 });

  // 6. Auto vs base
  reportGroup("AUTO STATUS",
    groupByKey(enrichCurr, r => r.cls.isAuto ? "AUTO" : "BASE"),
    groupByKey(enrichPrior, r => r.cls.isAuto ? "AUTO" : "BASE"),
    { minVolume: 100 });

  // 7. Auto style
  reportGroup("AUTO STYLE",
    groupByKey(enrichCurr, r => r.cls.autoStyle),
    groupByKey(enrichPrior, r => r.cls.autoStyle),
    { minVolume: 20 });

  // 8. Grade tier
  reportGroup("GRADE TIER",
    groupByKey(enrichCurr, r => r.cls.gradeCompany && r.cls.gradeValue != null ? `${r.cls.gradeCompany} ${r.cls.gradeValue}` : "raw"),
    groupByKey(enrichPrior, r => r.cls.gradeCompany && r.cls.gradeValue != null ? `${r.cls.gradeCompany} ${r.cls.gradeValue}` : "raw"),
    { minVolume: 50 });

  // 9. Product line (setKey slot)
  reportGroup("PRODUCT LINE",
    groupByKey(enrichCurr, r => r.cls.product),
    groupByKey(enrichPrior, r => r.cls.product),
    { minVolume: 100 });

  // 10. Sport × color for top sports
  const sportColorCurr = groupByKey(enrichCurr, r => `${r.cls.sport}:${r.cls.colorFamily}`);
  const sportColorPrior = groupByKey(enrichPrior, r => `${r.cls.sport}:${r.cls.colorFamily}`);
  reportGroup("SPORT × COLOR", sportColorCurr, sportColorPrior, { minVolume: 30 });
}

main().catch(e => { console.error(e); process.exit(1); });
