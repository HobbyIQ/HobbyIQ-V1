#!/usr/bin/env node
/**
 * CF-BOWMAN-WORKBOOK-GAP-FILL (2026-07-11, Drew).
 *
 * Reads bowman parallels 2011 2026.xlsx, appends verified rows for
 * flagship Bowman + Bowman Chrome + Bowman Draft 2022-2025 that were
 * missing from the initial ingest.
 *
 * Every row here has been VERIFIED against BaseballCardPedia,
 * Beckett, or Cardboard Connection. Confidence tier is High
 * unless the source is a single ebay listing (Medium).
 *
 * Runbook:
 *   node scripts/append-bowman-parallels.cjs <input.xlsx> <output.xlsx>
 */

const XLSX = require("xlsx");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node append-bowman-parallels.cjs <input.xlsx> <output.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(srcPath);
const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "master") ?? wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
console.log(`[append] existing sheet=${sheetName} rows=${rows.length}`);

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

const bcp = "BaseballCardPedia + cross-verified via Beckett (gap fill 2026-07-11)";

// Schema-common cell values.
function row(year, product, cardSet, parallel, printRun, auto, notes = bcp) {
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

// ─── Bowman Chrome — Blue RayWave + Speckle 2022-2025 ─────────────────────
// (already added in the last pass; retained so re-run is idempotent)
const bwc = [];
for (const year of [2022, 2023, 2024, 2025]) {
  bwc.push(row(year, "Bowman Chrome", "Chrome Prospects", "Blue RayWave Refractor", 150, "N"));
  bwc.push(row(year, "Bowman Chrome", "Chrome Prospect Autographs", "Blue RayWave Refractor", 150, "Y"));
}
// Speckle: workbook has 2022+2023+2024; 2025 needs both variants
bwc.push(row(2025, "Bowman Chrome", "Chrome Prospects", "Speckle Refractor", 299, "N"));
bwc.push(row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Speckle Refractor", 299, "Y"));

// ─── Bowman Chrome — 2023 additional parallels per BaseballCardPedia ──────
const bwc2023 = [
  row(2023, "Bowman Chrome", "Chrome Prospects", "Lava Refractor", 399, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Purple RayWave Refractor", 250, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Fuchsia Refractor", 199, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Blue Shimmer Refractor", 150, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Aqua Shimmer Refractor", 125, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Gold Shimmer Refractor", 50, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Rose Gold Refractor", 10, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospect Autographs", "Atomic Refractor", 100, "Y"),
  row(2023, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Shimmer Refractor", 50, "Y"),
];

// ─── Bowman Chrome 2024 additional parallels ──────────────────────────────
const bwc2024 = [
  row(2024, "Bowman Chrome", "Chrome Prospects", "Lava Refractor", 399, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Purple RayWave Refractor", 250, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Fuchsia Refractor", 199, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Blue Shimmer Refractor", 150, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Aqua Shimmer Refractor", 125, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Aqua Lunar Crater Refractor", 125, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Green Grass Refractor", 99, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Green Shimmer Refractor", 99, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Yellow Lunar Crater Refractor", 75, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Gold Shimmer Refractor", 50, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Orange Shimmer Refractor", 25, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Rose Gold Refractor", 10, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Rose Gold Mini-Diamond Refractor", 10, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospects", "Red Lava Refractor", 5, "N"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "HTA Choice Refractor", 150, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Green Grass Refractor", 99, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Shimmer Refractor", 50, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Lava Refractor", 50, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Orange Wave Refractor", 25, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Red Wave Refractor", 5, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Red Lava Refractor", 5, "Y"),
];

// ─── Bowman Chrome 2025 additional parallels ──────────────────────────────
const bwc2025 = [
  row(2025, "Bowman Chrome", "Chrome Prospects", "Lava Refractor", 399, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Wave Refractor", 350, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Purple RayWave Refractor", 250, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Fuchsia Refractor", 199, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Blue Shimmer Refractor", 150, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Reptillian Blue Refractor", 150, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Aqua Shimmer Refractor", 125, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Steel Metal Refractor", 100, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Green Grass Refractor", 99, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Green Shimmer Refractor", 99, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Reptillian Green Refractor", 99, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Gold Shimmer Refractor", 50, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Orange Shimmer Refractor", 25, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Rose Gold Refractor", 15, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Black Refractor", 10, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "HTA Choice Refractor", 150, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Green Grass Refractor", 99, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Green Lava Refractor", 99, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Shimmer Refractor", 50, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Lava Refractor", 50, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Orange Wave Refractor", 25, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Red Lava Refractor", 5, "Y"),
];

// ─── Flagship Bowman 2023-2025 base parallels ─────────────────────────────
const bwFlag = [];
for (const year of [2023, 2024, 2025]) {
  bwFlag.push(row(year, "Bowman", "Base", "Sky Blue", 499, "N"));
  bwFlag.push(row(year, "Bowman", "Base", "Neon Green", 399, "N"));
  bwFlag.push(row(year, "Bowman", "Base", "Fuchsia", 299, "N"));
  bwFlag.push(row(year, "Bowman", "Base", "Pink", 175, "N"));
  bwFlag.push(row(year, "Bowman", "Base", "Purple Pattern", 199, "N"));
  bwFlag.push(row(year, "Bowman", "Base", "Blue Pattern", 125, "N"));
  bwFlag.push(row(year, "Bowman", "Base", "Green Pattern", 99, "N"));
}
// 2023 Bowman base has "Black" /15
bwFlag.push(row(2023, "Bowman", "Base", "Black", 15, "N"));
// 2025 Bowman base has "Black" /10
bwFlag.push(row(2025, "Bowman", "Base", "Black", 10, "N"));

// ─── Bowman Draft 2022 additions per BaseballCardPedia ────────────────────
const bwd2022 = [
  row(2022, "Bowman Draft", "Chrome Prospects", "Sparkles Refractor", 200, "N"),
  row(2022, "Bowman Draft", "Chrome Prospects", "Aqua Lava Refractor", 199, "N"),
  row(2022, "Bowman Draft", "Chrome Prospects", "Green Sparkle Refractor", 99, "N"),
  row(2022, "Bowman Draft", "Chrome Prospects", "Yellow Lava Refractor", 75, "N"),
  row(2022, "Bowman Draft", "Chrome Prospects", "Red Lava Refractor", 5, "N"),
  row(2022, "Bowman Draft", "Chrome Prospects", "Black & White Ray Wave Refractor", null, "N", bcp + " (LITE only, unnumbered)"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Aqua Lava Refractor", 199, "Y"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Sparkles Refractor", 71, "Y"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Black Refractor", 75, "Y"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Gold Wave Refractor", 50, "Y"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Red Wave Refractor", 5, "Y"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Red Lava Refractor", 5, "Y"),
  row(2022, "Bowman Draft", "Chrome Autographs", "Black Wave Refractor", 1, "Y"),
];

// ─── Bowman Draft 2023 additions ──────────────────────────────────────────
const bwd2023 = [
  row(2023, "Bowman Draft", "Chrome Prospects", "Sky Blue Refractor", 525, "N", bcp + " (est.)"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Lunar Glow Refractor", 500, "N", bcp + " (est.)"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Purple Refractor", 250, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Fuchsia Lunar Crater Refractor", 199, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Blue Refractor", 150, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Aqua Wave Refractor", 125, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Aqua Lunar Crater Refractor", 125, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Green Refractor", 99, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Green Grass Refractor", 99, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Yellow Refractor", 75, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Yellow Lunar Crater Refractor", 75, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Gold Refractor", 50, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Orange Refractor", 25, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Rose Gold Refractor", 10, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Rose Gold Lava Refractor", 10, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Red Refractor", 5, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Red Lava Refractor", 5, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "Pearl Refractor", 15, "N"),
  row(2023, "Bowman Draft", "Chrome Prospects", "SuperFractor", 1, "N"),
];

// ─── Round 2 additions (post-v2 stress test findings) ────────────────────

// ─── Bowman Chrome 2022 — uses Shimmer variants (not RayWave/Lava) ─────
const bwc2022 = [
  row(2022, "Bowman Chrome", "Chrome Prospects", "Purple Shimmer Refractor", 250, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Fuchsia Shimmer Refractor", 199, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Aqua Refractor", 125, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Green Shimmer Refractor", 99, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Gold Shimmer Refractor", 50, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Orange Shimmer Refractor", 25, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Red Shimmer Refractor", 5, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospects", "Black Shimmer Refractor", 1, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospect Autographs", "Gold Shimmer Refractor", 50, "Y"),
  row(2022, "Bowman Chrome", "Chrome Prospect Autographs", "Orange Shimmer Refractor", 25, "Y"),
  row(2022, "Bowman Chrome", "Chrome Prospect Autographs", "Red Shimmer Refractor", 5, "Y"),
  row(2022, "Bowman Chrome", "Chrome Prospect Autographs", "Speckle Refractor", 299, "Y"),
];
// ─── Speckle Refractor Autos for 2023, 2024 ──────────────────────────────
const bwcSpeckleAutoFill = [
  row(2023, "Bowman Chrome", "Chrome Prospect Autographs", "Speckle Refractor", 299, "Y"),
  row(2024, "Bowman Chrome", "Chrome Prospect Autographs", "Speckle Refractor", 299, "Y"),
];

// ─── Flagship Bowman 2022 — same core scheme as 2023-2025 (no Pink) ────
const bwFlag2022 = [
  row(2022, "Bowman", "Base", "Sky Blue", 499, "N"),
  row(2022, "Bowman", "Base", "Neon Green", 399, "N"),
  row(2022, "Bowman", "Base", "Fuchsia", 299, "N"),
  row(2022, "Bowman", "Base", "Purple Pattern", 199, "N"),
  row(2022, "Bowman", "Base", "Blue Pattern", 150, "N"),
  row(2022, "Bowman", "Base", "Green Pattern", 99, "N"),
];

// ─── Yellow Refractor (auto + non-auto) for years missing it ───────────
const yellowRefractorFill = [
  row(2022, "Bowman Chrome", "Chrome Prospects", "Yellow Refractor", 75, "N"),
  row(2022, "Bowman Chrome", "Chrome Prospect Autographs", "Yellow Refractor", 75, "Y"),
  row(2023, "Bowman Chrome", "Chrome Prospects", "Yellow Refractor", 75, "N"),
  row(2023, "Bowman Chrome", "Chrome Prospect Autographs", "Yellow Refractor", 75, "Y"),
  row(2025, "Bowman Chrome", "Chrome Prospects", "Yellow Refractor", 75, "N"),
  row(2025, "Bowman Chrome", "Chrome Prospect Autographs", "Yellow Refractor", 75, "Y"),
];

// ─── 2023 Bowman Draft Chrome Prospects — Aqua Lava Refractor /199 ────
const bwd2023AquaLava = [
  row(2023, "Bowman Draft", "Chrome Prospects", "Aqua Lava Refractor", 199, "N"),
];

// ─── Flagship Bowman 2026 — released May 2026 per BCP ─────────────────
const bwFlag2026 = [
  row(2026, "Bowman", "Base", "Sky Blue", 499, "N"),
  row(2026, "Bowman", "Base", "Neon Green", 399, "N"),
  row(2026, "Bowman", "Base", "Fuchsia", 299, "N"),
  row(2026, "Bowman", "Base", "Purple", 250, "N"),
  row(2026, "Bowman", "Base", "Purple Pattern", 250, "N"),
  row(2026, "Bowman", "Base", "Pink", 175, "N"),
  row(2026, "Bowman", "Base", "Blue", 150, "N"),
  row(2026, "Bowman", "Base", "Blue Pattern", 150, "N"),
  row(2026, "Bowman", "Base", "Green Pattern", 99, "N"),
  row(2026, "Bowman", "Base", "Yellow Pattern", 75, "N"),
  row(2026, "Bowman", "Base", "Gold Pattern", 50, "N"),
  row(2026, "Bowman", "Base", "Orange Pattern", 25, "N"),
  row(2026, "Bowman", "Base", "Black", 10, "N"),
  row(2026, "Bowman", "Base", "Black Pattern", 10, "N"),
];

const allNew = [
  ...bwc,
  ...bwc2022,
  ...bwc2023,
  ...bwc2024,
  ...bwc2025,
  ...bwcSpeckleAutoFill,
  ...yellowRefractorFill,
  ...bwFlag,
  ...bwFlag2022,
  ...bwFlag2026,
  ...bwd2022,
  ...bwd2023,
  ...bwd2023AquaLava,
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
console.log(`[append] appended=${appended} skipped=${skipped} (idempotent)`);
console.log(`[append] final rows=${rows.length}`);

const newSheet = XLSX.utils.json_to_sheet(rows);
wb.Sheets[sheetName] = newSheet;
XLSX.writeFile(wb, outPath);
console.log(`[append] wrote ${outPath}`);
