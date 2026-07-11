#!/usr/bin/env node
/**
 * CF-HISTORIC-GAP-FILL-2010-2019 (2026-07-11, Drew).
 *
 * Extends the ladder back to 2010-2019 for Bowman Chrome, Topps Chrome,
 * Panini Prizm, and Donruss Optic. Sources: BaseballCardPedia + Beckett +
 * Cardboard Connection + Cardlines + agsportscards.
 *
 * Focus: NUMBERED parallels only (unnumbered "rainbow" tiers don't drive
 * ladder pricing since the ladder maps print-run → tier multiplier).
 *
 * Runbook:
 *   node scripts/append-historic-2010-2019.cjs <input.xlsx> <output.xlsx>
 */

const XLSX = require("xlsx");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node append-historic-2010-2019.cjs <input.xlsx> <output.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(srcPath);
const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "master") ?? wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
console.log(`[historic] existing sheet=${sheetName} rows=${rows.length}`);

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

const src = "BaseballCardPedia + Beckett + Cardboard Connection (historic 2010-2019 fill, 2026-07-11)";

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

// ─── Bowman Chrome 2013 ──────────────────────────────────────────────────
const bwc2013 = [
  row(2013, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 99, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Green Refractor", 75, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Black Refractor", 35, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Orange Refractor", 25, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Red Ice", 25, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Purple Ice", 10, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Black Ice", 1, "N"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 99, "Y"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "Y"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "Y"),
  row(2013, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "Y"),
];

// ─── Bowman Chrome Mini 2013 ─────────────────────────────────────────────
const bwcMini2013 = [
  row(2013, "Bowman Chrome Mini", "Base", "Blue Refractor", 99, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "Green Refractor", 75, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "Gold Refractor", 50, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "Black Refractor", 25, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "Orange Refractor", 15, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "Red Refractor", 10, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "Purple Refractor", 5, "N"),
  row(2013, "Bowman Chrome Mini", "Base", "SuperFractor", 1, "N"),
];

// ─── Bowman Chrome 2014 ──────────────────────────────────────────────────
const bwc2014 = [
  row(2014, "Bowman Chrome", "Chrome Prospects", "Refractor", 500, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 150, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Bubbles Refractor", 99, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Green Refractor", 75, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Carbon Fiber Refractor", 25, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Purple Bubbles Refractor", 10, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "N"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Refractor", 500, "Y"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 150, "Y"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "Y"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "Y"),
  row(2014, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "Y"),
];

// ─── Bowman Chrome Mini 2014 ─────────────────────────────────────────────
const bwcMini2014 = [
  row(2014, "Bowman Chrome Mini", "Base", "Yellow Refractor", 25, "N"),
  row(2014, "Bowman Chrome Mini", "Base", "Orange Refractor", 10, "N"),
  row(2014, "Bowman Chrome Mini", "Base", "Red Refractor", 5, "N"),
  row(2014, "Bowman Chrome Mini", "Base", "SuperFractor", 1, "N"),
];

// ─── Bowman Chrome 2015-2016 (Orange/Red/SuperFractor confirmed) ────────
const bwc2015 = [
  row(2015, "Bowman Chrome", "Chrome Prospects", "Orange Refractor", 25, "N"),
  row(2015, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "N"),
  row(2015, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "N"),
  row(2015, "Bowman Chrome", "Chrome Prospect Autographs", "Orange Refractor", 25, "Y"),
  row(2015, "Bowman Chrome", "Chrome Prospect Autographs", "Red Refractor", 5, "Y"),
  row(2015, "Bowman Chrome", "Chrome Prospect Autographs", "SuperFractor", 1, "Y"),
];
const bwc2016 = [
  row(2016, "Bowman Chrome", "Chrome Prospects", "Orange Refractor", 25, "N"),
  row(2016, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "N"),
  row(2016, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "N"),
  row(2016, "Bowman Chrome", "Chrome Prospect Autographs", "Orange Refractor", 25, "Y"),
  row(2016, "Bowman Chrome", "Chrome Prospect Autographs", "Red Refractor", 5, "Y"),
  row(2016, "Bowman Chrome", "Chrome Prospect Autographs", "SuperFractor", 1, "Y"),
];

// ─── Bowman Chrome 2017-2018 (standard rainbow ladder) ───────────────────
function bwcStandard(year) {
  return [
    row(year, "Bowman Chrome", "Chrome Prospects", "Refractor", 499, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Purple Refractor", 250, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Blue Refractor", 150, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Green Refractor", 99, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Gold Refractor", 50, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Orange Refractor", 25, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "Red Refractor", 5, "N"),
    row(year, "Bowman Chrome", "Chrome Prospects", "SuperFractor", 1, "N"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Refractor", 499, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Purple Refractor", 250, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Blue Refractor", 150, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Green Refractor", 99, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Refractor", 50, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Orange Refractor", 25, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Red Refractor", 5, "Y"),
    row(year, "Bowman Chrome", "Chrome Prospect Autographs", "SuperFractor", 1, "Y"),
  ];
}
const bwc2017 = bwcStandard(2017);
const bwc2018 = bwcStandard(2018);
// 2018 Chrome Prospect Shimmer:
bwc2018.push(
  row(2018, "Bowman Chrome", "Chrome Prospects", "Green Shimmer Refractor", 99, "N"),
  row(2018, "Bowman Chrome", "Chrome Prospects", "Gold Shimmer Refractor", 50, "N"),
  row(2018, "Bowman Chrome", "Chrome Prospects", "Orange Shimmer Refractor", 25, "N"),
  row(2018, "Bowman Chrome", "Chrome Prospects", "Black Shimmer Refractor", 5, "N"),
);

// ─── Bowman flagship 2013 ────────────────────────────────────────────────
const bw2013 = [
  row(2013, "Bowman", "Base", "Blue", 500, "N"),
  row(2013, "Bowman", "Base", "Orange", 250, "N"),
  row(2013, "Bowman", "Base", "Red", 5, "N"),
  row(2013, "Bowman", "Base", "Black", 1, "N"),
];

// ─── Topps Chrome 2010 ──────────────────────────────────────────────────
const tpc2010 = [
  row(2010, "Topps Chrome", "Base", "Blue Refractor", 199, "N"),
  row(2010, "Topps Chrome", "Base", "Gold Refractor", 50, "N"),
  row(2010, "Topps Chrome", "Base", "Red Refractor", 25, "N"),
  row(2010, "Topps Chrome", "Base", "SuperFractor", 1, "N"),
];

// ─── Topps Chrome 2018 ──────────────────────────────────────────────────
const tpc2018 = [
  row(2018, "Topps Chrome", "Base", "Purple Refractor", 299, "N"),
  row(2018, "Topps Chrome", "Base", "Blue Refractor", 150, "N"),
  row(2018, "Topps Chrome", "Base", "Green Refractor", 99, "N"),
  row(2018, "Topps Chrome", "Base", "Green Wave Refractor", 99, "N"),
  row(2018, "Topps Chrome", "Base", "Blue Wave Refractor", 75, "N"),
  row(2018, "Topps Chrome", "Base", "Gold Refractor", 50, "N"),
  row(2018, "Topps Chrome", "Base", "Gold Wave Refractor", 50, "N"),
  row(2018, "Topps Chrome", "Base", "Orange Refractor", 25, "N"),
  row(2018, "Topps Chrome", "Base", "Red Refractor", 5, "N"),
  row(2018, "Topps Chrome", "Base", "Red Wave Refractor", 5, "N"),
  row(2018, "Topps Chrome", "Base", "SuperFractor", 1, "N"),
];

// ─── Topps Chrome 2019 ──────────────────────────────────────────────────
const tpc2019 = [
  row(2019, "Topps Chrome", "Base", "Purple Refractor", 299, "N"),
  row(2019, "Topps Chrome", "Base", "Blue Refractor", 150, "N"),
  row(2019, "Topps Chrome", "Base", "Green Refractor", 99, "N"),
  row(2019, "Topps Chrome", "Base", "Green Wave Refractor", 99, "N"),
  row(2019, "Topps Chrome", "Base", "Blue Wave Refractor", 75, "N"),
  row(2019, "Topps Chrome", "Base", "Gold Refractor", 50, "N"),
  row(2019, "Topps Chrome", "Base", "Gold Wave Refractor", 50, "N"),
  row(2019, "Topps Chrome", "Base", "Orange Refractor", 25, "N"),
  row(2019, "Topps Chrome", "Base", "Orange Wave Refractor", 25, "N"),
  row(2019, "Topps Chrome", "Base", "Red Refractor", 5, "N"),
  row(2019, "Topps Chrome", "Base", "Red Wave Refractor", 5, "N"),
  row(2019, "Topps Chrome", "Base", "SuperFractor", 1, "N"),
];

// ─── Panini Prizm 2012 (inaugural) ──────────────────────────────────────
const prizm2012 = [
  row(2012, "Panini Prizm", "Base", "Gold Prizm", 10, "N"),
  row(2012, "Panini Prizm", "Base", "Black Finite Prizm", 1, "N"),
];

// ─── Panini Prizm 2013 ──────────────────────────────────────────────────
const prizm2013 = [
  row(2013, "Panini Prizm", "Base", "Orange Diecut", 50, "N"),
  row(2013, "Panini Prizm", "Base", "Gold Prizm", 10, "N"),
  row(2013, "Panini Prizm", "Base", "Black Finite Prizm", 1, "N"),
];

// ─── Panini Prizm 2015 ──────────────────────────────────────────────────
const prizm2015 = [
  row(2015, "Panini Prizm", "Base", "Camo", 199, "N"),
  row(2015, "Panini Prizm", "Base", "Black and White Checker", 149, "N"),
  row(2015, "Panini Prizm", "Base", "Red Power", 125, "N"),
  row(2015, "Panini Prizm", "Base", "Purple Flash", 99, "N"),
  row(2015, "Panini Prizm", "Base", "Tie Dye", 50, "N"),
  row(2015, "Panini Prizm", "Base", "Gold Prizm", 10, "N"),
  row(2015, "Panini Prizm", "Base", "Black Finite Prizm", 1, "N"),
];

// ─── Panini Prizm 2019 ──────────────────────────────────────────────────
const prizm2019 = [
  row(2019, "Panini Prizm", "Base", "Gold Prizm", 10, "N"),
  row(2019, "Panini Prizm", "Base", "Black Finite Prizm", 1, "N"),
];

// ─── Donruss Optic 2016-2018 ────────────────────────────────────────────
const optic2016 = [
  row(2016, "Donruss Optic", "Base", "Blue", 149, "N"),
  row(2016, "Donruss Optic", "Base", "Red", 99, "N"),
  row(2016, "Donruss Optic", "Base", "Gold", 10, "N"),
  row(2016, "Donruss Optic", "Base", "Green", 5, "N"),
  row(2016, "Donruss Optic", "Base", "Gold Vinyl", 1, "N"),
];
const optic2017 = [
  row(2017, "Donruss Optic", "Base", "Aqua", 299, "N"),
  row(2017, "Donruss Optic", "Base", "Orange", 199, "N"),
  row(2017, "Donruss Optic", "Base", "Blue", 149, "N"),
  row(2017, "Donruss Optic", "Base", "Red", 99, "N"),
  row(2017, "Donruss Optic", "Base", "Carolina Blue", 50, "N"),
  row(2017, "Donruss Optic", "Base", "Black", 25, "N"),
  row(2017, "Donruss Optic", "Base", "Gold", 10, "N"),
  row(2017, "Donruss Optic", "Base", "Green", 5, "N"),
  row(2017, "Donruss Optic", "Base", "Gold Vinyl", 1, "N"),
];
const optic2018 = [
  row(2018, "Donruss Optic", "Base", "Aqua", 299, "N"),
  row(2018, "Donruss Optic", "Base", "Orange", 199, "N"),
  row(2018, "Donruss Optic", "Base", "Blue", 149, "N"),
  row(2018, "Donruss Optic", "Base", "Red", 99, "N"),
  row(2018, "Donruss Optic", "Base", "Carolina Blue", 50, "N"),
  row(2018, "Donruss Optic", "Base", "Black", 25, "N"),
  row(2018, "Donruss Optic", "Base", "Gold", 10, "N"),
  row(2018, "Donruss Optic", "Base", "Cracked Ice FOTL", 7, "N"),
  row(2018, "Donruss Optic", "Base", "Green", 5, "N"),
  row(2018, "Donruss Optic", "Base", "Gold Vinyl", 1, "N"),
];

const allNew = [
  ...bwc2013,
  ...bwcMini2013,
  ...bwc2014,
  ...bwcMini2014,
  ...bwc2015,
  ...bwc2016,
  ...bwc2017,
  ...bwc2018,
  ...bw2013,
  ...tpc2010,
  ...tpc2018,
  ...tpc2019,
  ...prizm2012,
  ...prizm2013,
  ...prizm2015,
  ...prizm2019,
  ...optic2016,
  ...optic2017,
  ...optic2018,
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
console.log(`[historic] appended=${appended} skipped=${skipped}`);
console.log(`[historic] final rows=${rows.length}`);

const newSheet = XLSX.utils.json_to_sheet(rows);
wb.Sheets[sheetName] = newSheet;
XLSX.writeFile(wb, outPath);
console.log(`[historic] wrote ${outPath}`);
