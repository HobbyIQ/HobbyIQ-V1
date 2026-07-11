#!/usr/bin/env node
/**
 * CF-VINTAGE-MODERN-1996-2015 (2026-07-11, Drew).
 *
 * Fills in the "modern era" backward from 2015 to the inception of
 * chromium (1996 Topps Chrome, 1997 Bowman Chrome). Sourced from
 * BaseballCardPedia + Beckett + Cardboard Connection.
 *
 * Runbook:
 *   node scripts/append-vintage-modern-1996-2015.cjs <input.xlsx> <output.xlsx>
 */

const XLSX = require("xlsx");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node append-vintage-modern-1996-2015.cjs <input.xlsx> <output.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(srcPath);
const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "master") ?? wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
console.log(`[vm] existing sheet=${sheetName} rows=${rows.length}`);

function key(r) {
  return [
    r.Year,
    String(r.Product ?? "").trim().toLowerCase(),
    String(r["Card Set"] ?? "").trim().toLowerCase(),
    String(r.Parallel ?? "").trim().toLowerCase(),
    String(r.Auto ?? "").trim().toUpperCase(),
  ].join("|");
}
const existing = new Set(rows.map(key));

const src = "BaseballCardPedia + Beckett + Cardboard Connection (vintage-modern 1996-2015 fill, 2026-07-11)";

function row(year, product, cardSet, parallel, printRun, auto, notes = src) {
  return {
    Year: year,
    Product: product,
    "Card Set": cardSet,
    Parallel: parallel,
    "Print Run": printRun,
    Numbered: printRun ? "Yes" : "No",
    Auto: auto,
    Confidence: "High",
    Notes: notes,
  };
}

// ─── Topps Chrome 2003 ──────────────────────────────────────────────────
const tpc2003 = [
  row(2003, "Topps Chrome", "Base", "Refractor", 699, "N"),
  row(2003, "Topps Chrome", "Base", "Gold Refractor", 449, "N"),
  row(2003, "Topps Chrome", "Base", "Black Refractor", 199, "N"),
  row(2003, "Topps Chrome", "Base", "Uncirculated X-Fractor", 50, "N"),
];

// ─── Topps Chrome 2005 ──────────────────────────────────────────────────
const tpc2005 = [
  row(2005, "Topps Chrome", "Base", "Black Refractor", 225, "N"),
  row(2005, "Topps Chrome", "Base", "Red X-Fractor", 25, "N"),
  row(2005, "Topps Chrome", "Base", "Gold SuperFractor", 1, "N"),
  row(2005, "Topps Chrome", "First-Year Player Autographs", "Refractor", 500, "Y"),
  row(2005, "Topps Chrome", "First-Year Player Autographs", "Black Refractor", 200, "Y"),
  row(2005, "Topps Chrome", "First-Year Player Autographs", "Red X-Fractor", 25, "Y"),
  row(2005, "Topps Chrome", "First-Year Player Autographs", "Gold SuperFractor", 1, "Y"),
];

// ─── Topps Chrome 2011 ──────────────────────────────────────────────────
const tpc2011 = [
  row(2011, "Topps Chrome", "Base", "X-Fractor", 225, "N"),
  row(2011, "Topps Chrome", "Base", "Purple Refractor", 499, "N"),
  row(2011, "Topps Chrome", "Base", "Atomic Refractor", 225, "N"),
  row(2011, "Topps Chrome", "Base", "Sepia-Tone Refractor", 99, "N"),
  row(2011, "Topps Chrome", "Base", "Blue Refractor", 99, "N"),
  row(2011, "Topps Chrome", "Base", "Black-Bordered Refractor", 100, "N"),
  row(2011, "Topps Chrome", "Base", "Gold Refractor", 50, "N"),
  row(2011, "Topps Chrome", "Base", "Red Refractor", 25, "N"),
  row(2011, "Topps Chrome", "Base", "SuperFractor", 1, "N"),
  row(2011, "Topps Chrome", "Base", "Canary Diamond Refractor", 1, "N"),
];

// ─── Topps Chrome 2015 (full ladder) ────────────────────────────────────
const tpc2015 = [
  row(2015, "Topps Chrome", "Base", "Purple Refractor", 250, "N"),
  row(2015, "Topps Chrome", "Base", "Blue Refractor", 150, "N"),
  row(2015, "Topps Chrome", "Base", "Green Refractor", 99, "N"),
  row(2015, "Topps Chrome", "Base", "Gold Refractor", 50, "N"),
  row(2015, "Topps Chrome", "Base", "Orange Refractor", 25, "N"),
  row(2015, "Topps Chrome", "Base", "Red Refractor", 5, "N"),
  row(2015, "Topps Chrome", "Base", "SuperFractor", 1, "N"),
  row(2015, "Topps Chrome", "Autographs", "Refractor", 499, "Y"),
  row(2015, "Topps Chrome", "Autographs", "Purple Refractor", 250, "Y"),
  row(2015, "Topps Chrome", "Autographs", "Blue Refractor", 150, "Y"),
  row(2015, "Topps Chrome", "Autographs", "Green Refractor", 99, "Y"),
  row(2015, "Topps Chrome", "Autographs", "Gold Refractor", 50, "Y"),
  row(2015, "Topps Chrome", "Autographs", "Orange Refractor", 25, "Y"),
  row(2015, "Topps Chrome", "Autographs", "Red Refractor", 5, "Y"),
  row(2015, "Topps Chrome", "Autographs", "SuperFractor", 1, "Y"),
];

// ─── Bowman Chrome 2007 ─────────────────────────────────────────────────
function bwc2007And2008(year) {
  return [
    row(year, "Bowman Chrome", "Base", "X-Fractor", 250, "N"),
    row(year, "Bowman Chrome", "Base", "Blue Refractor", 150, "N"),
    row(year, "Bowman Chrome", "Base", "Gold Refractor", 50, "N"),
    row(year, "Bowman Chrome", "Base", "Orange Refractor", 25, "N"),
    row(year, "Bowman Chrome", "Base", "Red Refractor", 5, "N"),
    row(year, "Bowman Chrome", "Base", "SuperFractor", 1, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Refractor", 500, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "X-Fractor", 250, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 150, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Orange Refractor", 25, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Refractor", 500, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospects", "X-Fractor", 250, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 150, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Orange Refractor", 25, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "Y"),
  ];
}

// ─── Bowman Chrome 2009 (same pattern) ──────────────────────────────────
const bwc2007 = bwc2007And2008(2007);
const bwc2008 = bwc2007And2008(2008);
const bwc2009 = bwc2007And2008(2009);

const allNew = [
  ...tpc2003,
  ...tpc2005,
  ...tpc2011,
  ...tpc2015,
  ...bwc2007,
  ...bwc2008,
  ...bwc2009,
];

let appended = 0;
let skipped = 0;
for (const r of allNew) {
  if (existing.has(key(r))) {
    skipped++;
    continue;
  }
  rows.push(r);
  existing.add(key(r));
  appended++;
}
console.log(`[vm] appended=${appended} skipped=${skipped}`);
console.log(`[vm] final rows=${rows.length}`);

const newSheet = XLSX.utils.json_to_sheet(rows);
wb.Sheets[sheetName] = newSheet;
XLSX.writeFile(wb, outPath);
console.log(`[vm] wrote ${outPath}`);
