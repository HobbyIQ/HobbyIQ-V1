#!/usr/bin/env node
/**
 * CF-BOWMAN-PARALLELS-DATASET (2026-07-09, Drew).
 *
 * One-time / on-update script that reads Drew's Bowman parallels
 * reference workbook (bowman parallels 2011 2026.xlsx) and writes a
 * bundled JSON dataset the engine can load at startup.
 *
 * Input:  CSV path (Master sheet, exported via Excel to CSV)
 * Output: backend/data/bowman-parallels.json
 *
 * Usage:
 *   node backend/scripts/build-bowman-parallels-dataset.cjs \
 *     "C:\\Users\\dvabu\\AppData\\Local\\Temp\\bowman_parallels\\Master.csv"
 */

const fs = require("node:fs");
const path = require("node:path");

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error("Usage: build-bowman-parallels-dataset.cjs <Master.csv>");
    process.exit(1);
  }

  const csvText = fs.readFileSync(inputPath, "utf-8");
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iYear = idx("Year");
  const iProduct = idx("Product");
  const iCardSet = idx("Card Set");
  const iParallel = idx("Parallel");
  const iPrintRun = idx("Print Run");
  const iNumbered = idx("Numbered");
  const iAuto = idx("Auto");
  const iConfidence = idx("Confidence");
  const iNotes = idx("Notes");
  if (
    iYear < 0 ||
    iProduct < 0 ||
    iCardSet < 0 ||
    iParallel < 0 ||
    iPrintRun < 0
  ) {
    console.error(
      "Missing required columns. Expected: Year, Product, Card Set, Parallel, Print Run, Numbered, Auto, Confidence, Notes",
    );
    console.error("Got: " + header.join(", "));
    process.exit(1);
  }

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const year = parseInt(cells[iYear], 10);
    if (!Number.isFinite(year)) continue;
    const product = String(cells[iProduct] ?? "").trim();
    const cardSet = String(cells[iCardSet] ?? "").trim();
    const parallel = String(cells[iParallel] ?? "").trim();
    const printRunRaw = String(cells[iPrintRun] ?? "").trim();
    const numberedRaw = String(cells[iNumbered] ?? "").trim();
    const autoRaw = String(cells[iAuto] ?? "").trim();
    const confidence = String(cells[iConfidence] ?? "").trim();
    const notes = String(cells[iNotes] ?? "").trim();
    const printRun =
      printRunRaw && Number.isFinite(parseInt(printRunRaw, 10))
        ? parseInt(printRunRaw, 10)
        : null;
    const numbered = /^(y|yes)$/i.test(numberedRaw);
    const isAuto = /^(y|yes)$/i.test(autoRaw);
    entries.push({
      year,
      product,
      cardSet,
      parallel,
      printRun,
      numbered,
      auto: isAuto,
      confidence,
      notes: notes || null,
    });
  }

  const dataset = {
    generatedAt: "2026-07-09",
    source: "bowman parallels 2011 2026.xlsx (Drew reference)",
    scope: "Bowman family, 2011-2026, base + auto parallels",
    yearRange: {
      min: Math.min(...entries.map((e) => e.year)),
      max: Math.max(...entries.map((e) => e.year)),
    },
    entryCount: entries.length,
    productCounts: entries.reduce((acc, e) => {
      acc[e.product] = (acc[e.product] ?? 0) + 1;
      return acc;
    }, {}),
    entries,
  };

  const outPath = path.resolve(__dirname, "..", "data", "bowman-parallels.json");
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2));
  console.log(
    `Wrote ${outPath} (${entries.length} entries, years ${dataset.yearRange.min}-${dataset.yearRange.max})`,
  );
}

main();
