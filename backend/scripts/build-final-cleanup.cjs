#!/usr/bin/env node
/**
 * CF-FINAL-CLEANUP (2026-07-11, Drew).
 *
 * Fills the last 7 year gaps + naming-mismatch productKeys the
 * audit flagged as still missing after the finish-year-gaps round.
 */

const XLSX = require("xlsx");

const [outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node build-final-cleanup.cjs <output.xlsx>");
  process.exit(1);
}

function setRow(yearText, setName, manufacturer, setType, setSize, format = "Card", keyNotes = "final cleanup 2026-07-11", confidence = "High") {
  return {
    "Year(s)": yearText, Set: setName, Manufacturer: manufacturer, Type: setType,
    "Set Size": setSize, Format: format, "Key Notes": keyNotes, Confidence: confidence,
  };
}

const rows = [];

// stadium-club 2009-2013
for (const y of [2009, 2010, 2011, 2012, 2013]) {
  rows.push(setRow(String(y), "Stadium Club", "Topps", "Premium", 720, "Card"));
}

// elite-extra-edition 2008-2009
rows.push(setRow("2008", "Panini Elite Extra Edition", "Donruss/Panini", "Draft Premium", 200, "Card"));
rows.push(setRow("2009", "Panini Elite Extra Edition", "Donruss/Panini", "Draft Premium", 200, "Card"));

// Skybox Metal (not Metal Universe) 1996-2001
for (let y = 1996; y <= 2001; y++) {
  rows.push(setRow(String(y), "Skybox Metal", "Fleer/Skybox", "Metallic", 220, "Card"));
}

// Skybox E-X 2001
rows.push(setRow("2001", "Skybox E-X", "Fleer/Skybox", "Premium Acetate", 100, "Card"));

console.log(`[cleanup] generated ${rows.length} SetDocs`);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Final cleanup", ""]]), "README");
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Catalog");
XLSX.writeFile(wb, outPath);
console.log(`[cleanup] wrote ${outPath}`);
