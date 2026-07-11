#!/usr/bin/env node
/**
 * CF-EXTRACT-STRESS-TEST-ROWS (2026-07-11, Drew).
 *
 * Reads a stress-test-shaped workbook (Cards + Parallel Reference +
 * Product Coverage sheets) and produces a reference-catalog-shaped
 * output workbook. The stress test is Drew's own curated canonical
 * data — using it as the source of truth for parallels + print runs
 * is faster and more accurate than manual per-row research.
 *
 * Deduplication:
 *   * Extract unique (year, product, cardSet, parallel, auto, printRun)
 *     tuples from the Cards sheet.
 *   * Coerce "Serial Number" → integer where possible.
 *   * Handle "YEAR" as a variable print run (e.g. Topps Gold /YEAR
 *     means /2020, /2021, etc.).
 *   * Drop Base and Base Auto tuples — the ladder is scarcity-only.
 *
 * Confidence: "High" — the workbook is owner-curated.
 * Notes: source workbook filename + "stress-test extraction 2026-07-11"
 *
 * Runbook:
 *   node scripts/extract-stress-test-rows.cjs <input.xlsx> <output.xlsx>
 */

const XLSX = require("xlsx");
const path = require("node:path");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node extract-stress-test-rows.cjs <input.xlsx> <output.xlsx>");
  process.exit(1);
}

const src = XLSX.readFile(srcPath);
const cardsSheet = src.Sheets["Cards"];
if (!cardsSheet) {
  console.error("Missing 'Cards' sheet");
  process.exit(1);
}
const cards = XLSX.utils.sheet_to_json(cardsSheet);
console.log(`[extract] loaded ${cards.length} cards from ${path.basename(srcPath)}`);

function parsePrintRun(raw, year) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === "" || s === "unnumbered") return null;
  if (s.toUpperCase() === "YEAR") return typeof year === "number" ? year : null;
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const tupleMap = new Map();
let skippedBase = 0;
let skippedMissingFields = 0;

for (const card of cards) {
  const year = Number(card.Year);
  const product = String(card.Set ?? "").trim();
  const cardSet = String(card["Card Type"] ?? "").trim();
  const parallel = String(card.Parallel ?? "").trim();
  const parallelFamily = String(card["Parallel Family"] ?? "").trim();
  const autoStr = String(card["Auto Y/N"] ?? "").trim().toUpperCase();
  const auto = autoStr === "Y" || autoStr === "YES";

  if (!year || !product || !parallel) {
    skippedMissingFields++;
    continue;
  }
  const parallelLc = parallel.toLowerCase();
  if (parallelLc === "base" || parallelLc === "base auto" || parallelLc === "base chrome") {
    skippedBase++;
    continue;
  }

  const printRun = parsePrintRun(card["Serial Number"], year);
  const key = `${year}|${product.toLowerCase()}|${cardSet.toLowerCase()}|${parallel.toLowerCase()}|${auto}`;
  if (tupleMap.has(key)) continue;

  tupleMap.set(key, {
    Year: year,
    Product: product,
    "Card Set": cardSet || parallelFamily || "Base",
    Parallel: parallel,
    "Print Run": printRun ?? "",
    Numbered: printRun ? "Yes" : "No",
    Auto: auto ? "Y" : "N",
    Confidence: "High",
    Notes: `stress-test extraction from ${path.basename(srcPath)} (2026-07-11)`,
  });
}

const outputRows = [...tupleMap.values()];
console.log(`[extract] unique tuples: ${outputRows.length}`);
console.log(`[extract] skipped base cards: ${skippedBase}`);
console.log(`[extract] skipped missing fields: ${skippedMissingFields}`);

// Build output workbook
const outWb = XLSX.utils.book_new();
const outSheet = XLSX.utils.json_to_sheet(outputRows);
XLSX.utils.book_append_sheet(outWb, outSheet, "Master");
XLSX.writeFile(outWb, outPath);
console.log(`[extract] wrote ${outPath}`);
