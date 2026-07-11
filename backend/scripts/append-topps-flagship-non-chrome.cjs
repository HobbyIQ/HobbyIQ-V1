#!/usr/bin/env node
/**
 * CF-TOPPS-FLAGSHIP-NON-CHROME (2026-07-11, Drew).
 *
 * Adds Topps flagship (paper — Series 1, Series 2, Update) base
 * parallels 2010-2019. Modern rainbow: Rainbow Foil, Gold /YEAR,
 * Vintage Stock /99, Black /67-69, holiday parallels (Mother's Day /50,
 * Father's Day /50, Memorial Day /25, Independence Day /76), Platinum /1.
 *
 * Sources: BaseballCardPedia + Beckett + Cardboard Connection.
 */

const XLSX = require("xlsx");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node append-topps-flagship-non-chrome.cjs <input.xlsx> <output.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(srcPath);
const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "master") ?? wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
console.log(`[tf] existing=${rows.length}`);

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

const src = "BaseballCardPedia + Beckett + Cardboard Connection (Topps flagship non-Chrome 2010-2019, 2026-07-11)";

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

const allNew = [];

// ─── 2010 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2010, product, "Base", "Gold", 2010, "N"),
    row(2010, product, "Base", "Black", 59, "N"),
    row(2010, product, "Base", "Platinum", 1, "N"),
    row(2010, product, "Base", "Throwback", null, "N", src + " (Target exclusive, unnumbered)"),
    row(2010, product, "Base", "All-Black", null, "N", src + " (Walmart exclusive, unnumbered)"),
  );
}

// ─── 2011 Topps Series 1/2/Update (Diamond Anniversary) ─────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2011, product, "Base", "Gold", 2011, "N"),
    row(2011, product, "Base", "Black Border", 60, "N"),
    row(2011, product, "Base", "Platinum", 1, "N"),
    row(2011, product, "Base", "Canary Diamond Anniversary", 1, "N"),
  );
}

// ─── 2012 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2012, product, "Base", "Gold", 2012, "N"),
    row(2012, product, "Base", "Truly Golden", 1, "N"),
  );
}

// ─── 2015 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2015, product, "Base", "Rainbow Foil", null, "N", src + " (1:10 packs, unnumbered)"),
    row(2015, product, "Base", "Gold", 2015, "N"),
    row(2015, product, "Base", "Snow Camo", 99, "N"),
    row(2015, product, "Base", "Black", 64, "N"),
    row(2015, product, "Base", "Pink", 50, "N"),
    row(2015, product, "Base", "Platinum", 1, "N"),
  );
}

// ─── 2016 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2016, product, "Base", "Rainbow Foil", null, "N", src + " (1:10 packs, unnumbered)"),
    row(2016, product, "Base", "Gold", 2016, "N"),
    row(2016, product, "Base", "Clear", 10, "N"),
    row(2016, product, "Base", "Vintage", null, "N", src + " (unnumbered)"),
    row(2016, product, "Base", "Negative", null, "N", src + " (Hobby/Jumbo only, unnumbered)"),
    row(2016, product, "Base", "Platinum", 1, "N"),
  );
}

// ─── 2017 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2017, product, "Base", "Rainbow Foil", null, "N", src + " (1:10 packs)"),
    row(2017, product, "Base", "Gold", 2017, "N"),
    row(2017, product, "Base", "Vintage Stock", 99, "N"),
    row(2017, product, "Base", "Black", 66, "N"),
    row(2017, product, "Base", "Mother's Day Hot Pink", 50, "N"),
    row(2017, product, "Base", "Father's Day Powder Blue", 50, "N"),
    row(2017, product, "Base", "Memorial Day Camo", 25, "N"),
    row(2017, product, "Base", "Clear", 10, "N"),
    row(2017, product, "Base", "Platinum", 1, "N"),
  );
}

// ─── 2018 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2018, product, "Base", "Rainbow Foil", null, "N"),
    row(2018, product, "Base", "Gold", 2018, "N"),
    row(2018, product, "Base", "Vintage Stock", 99, "N"),
    row(2018, product, "Base", "Independence Day", 76, "N"),
    row(2018, product, "Base", "Black", 67, "N"),
    row(2018, product, "Base", "Mother's Day Hot Pink", 50, "N"),
    row(2018, product, "Base", "Father's Day Powder Blue", 50, "N"),
    row(2018, product, "Base", "Memorial Day Camo", 25, "N"),
    row(2018, product, "Base", "Platinum", 1, "N"),
  );
}

// ─── 2019 Topps Series 1/2/Update ────────────────────────────────────────
for (const product of ["Topps Series 1", "Topps Series 2", "Topps Update"]) {
  allNew.push(
    row(2019, product, "Base", "Rainbow Foil", null, "N"),
    row(2019, product, "Base", "Gold", 2019, "N"),
    row(2019, product, "Base", "Vintage Stock", 99, "N"),
    row(2019, product, "Base", "Independence Day", 76, "N"),
    row(2019, product, "Base", "Black", 67, "N"),
    row(2019, product, "Base", "Mother's Day Pink", 50, "N"),
    row(2019, product, "Base", "Father's Day Blue", 50, "N"),
    row(2019, product, "Base", "Memorial Day Camo", 25, "N"),
    row(2019, product, "Base", "Platinum", 1, "N"),
  );
}

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
console.log(`[tf] appended=${appended} skipped=${skipped}`);
console.log(`[tf] final rows=${rows.length}`);

const newSheet = XLSX.utils.json_to_sheet(rows);
wb.Sheets[sheetName] = newSheet;
XLSX.writeFile(wb, outPath);
console.log(`[tf] wrote ${outPath}`);
