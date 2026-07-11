#!/usr/bin/env node
/**
 * CF-PANINI-HISTORIC-GAP-FILL (2026-07-11, Drew).
 *
 * Appends verified Panini + historic manufacturer parallels for 2020-2025
 * to the reference workbook. Sourced from BaseballCardPedia + Beckett +
 * Cardboard Connection + Cardsmiths + Cardlines.
 *
 * Products covered:
 *   * Panini Prizm 2020-2025
 *   * Panini Donruss 2023-2024
 *   * Panini Impeccable 2024
 *   * Panini National Treasures 2024
 *   * Panini Chronicles 2022
 *   * Onyx Vintage 2024
 *
 * Only VERIFIED numbered parallels included. Where multiple sources
 * disagree, I've defaulted to BaseballCardPedia. Where a source says
 * "print runs unannounced" for unnumbered, those rows are dropped
 * (Numbered=No isn't ladder-useful).
 *
 * Runbook:
 *   node scripts/append-panini-historic-parallels.cjs <input.xlsx> <output.xlsx>
 */

const XLSX = require("xlsx");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node append-panini-historic-parallels.cjs <input.xlsx> <output.xlsx>");
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

const src = "BaseballCardPedia + Beckett + Cardboard Connection (Panini + historic gap fill 2026-07-11)";

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

// ─── Panini Prizm 2020 ────────────────────────────────────────────────────
const prizm2020 = [
  row(2020, "Panini Prizm", "Base", "Blue Mojo", 175, "N"),
  row(2020, "Panini Prizm", "Base", "Red Mojo", 149, "N"),
  row(2020, "Panini Prizm", "Base", "Lime Green", 125, "N"),
  row(2020, "Panini Prizm", "Base", "Neon Orange", 100, "N"),
  row(2020, "Panini Prizm", "Base", "Red Wave", 99, "N"),
  row(2020, "Panini Prizm", "Base", "Power Plaid", 75, "N"),
  row(2020, "Panini Prizm", "Base", "Blue Wave", 60, "N"),
  row(2020, "Panini Prizm", "Base", "Snake Skin", 50, "N"),
  row(2020, "Panini Prizm", "Base", "Gold", 10, "N"),
  row(2020, "Panini Prizm", "Base", "Black Finite", 1, "N"),
];

// ─── Panini Prizm 2021 ────────────────────────────────────────────────────
const prizm2021 = [
  row(2021, "Panini Prizm", "Base", "Blue", 149, "N"),
  row(2021, "Panini Prizm", "Base", "Red", 99, "N"),
  row(2021, "Panini Prizm", "Base", "Purple", 50, "N"),
  row(2021, "Panini Prizm", "Base", "Gold Pandora", 50, "N"),
  row(2021, "Panini Prizm", "Base", "Pink", 50, "N"),
  row(2021, "Panini Prizm", "Base", "Gold", 10, "N"),
  row(2021, "Panini Prizm", "Base", "Black Finite", 1, "N"),
];

// ─── Panini Prizm 2023 ────────────────────────────────────────────────────
// Note: 2023 Prizm largely uses unnumbered rainbow parallels; only Gold + Black Finite have official print runs.
const prizm2023 = [
  row(2023, "Panini Prizm", "Base", "Gold", 10, "N"),
  row(2023, "Panini Prizm", "Base", "Black Finite", 1, "N"),
];

// ─── Panini Prizm 2024 ────────────────────────────────────────────────────
const prizm2024 = [
  row(2024, "Panini Prizm", "Base", "Pulsar", 499, "N"),
  row(2024, "Panini Prizm", "Base", "Orange Pulsar", 399, "N"),
  row(2024, "Panini Prizm", "Base", "Red Pulsar", 399, "N"),
  row(2024, "Panini Prizm", "Base", "Red", 299, "N"),
  row(2024, "Panini Prizm", "Base", "Blue", 199, "N"),
  row(2024, "Panini Prizm", "Base", "Premium Box Set", 199, "N"),
  row(2024, "Panini Prizm", "Base", "Purple", 99, "N"),
  row(2024, "Panini Prizm", "Base", "Green Scope", 75, "N"),
  row(2024, "Panini Prizm", "Base", "Blue Pulsar", 75, "N"),
  row(2024, "Panini Prizm", "Base", "Orange Wave", 49, "N"),
  row(2024, "Panini Prizm", "Base", "Mojo", 25, "N"),
  row(2024, "Panini Prizm", "Base", "Green Pulsar", 25, "N"),
  row(2024, "Panini Prizm", "Base", "Blue Shimmer FOTL", 15, "N"),
  row(2024, "Panini Prizm", "Base", "Gold", 10, "N"),
  row(2024, "Panini Prizm", "Base", "Gold Shimmer FOTL", 7, "N"),
  row(2024, "Panini Prizm", "Base", "Black Gold", 5, "N"),
  row(2024, "Panini Prizm", "Base", "Premium Box Set Gold", 4, "N"),
  row(2024, "Panini Prizm", "Base", "Black Gold Shimmer FOTL", 3, "N"),
  row(2024, "Panini Prizm", "Base", "Gold Vinyl", 1, "N"),
  row(2024, "Panini Prizm", "Base", "Black Finite", 1, "N"),
];

// ─── Panini Prizm 2025 ────────────────────────────────────────────────────
const prizm2025 = [
  row(2025, "Panini Prizm", "Base", "Pulsar", 499, "N"),
  row(2025, "Panini Prizm", "Base", "Orange Pulsar", 399, "N"),
  row(2025, "Panini Prizm", "Base", "Red", 99, "N"),
  row(2025, "Panini Prizm", "Base", "Blue", 49, "N"),
  row(2025, "Panini Prizm", "Base", "Mojo", 25, "N"),
  row(2025, "Panini Prizm", "Base", "Gold", 10, "N"),
  row(2025, "Panini Prizm", "Base", "Blue Shimmer FOTL", 8, "N"),
  row(2025, "Panini Prizm", "Base", "Gold Shimmer FOTL", 2, "N"),
  row(2025, "Panini Prizm", "Base", "Black Finite", 1, "N"),
  row(2025, "Panini Prizm", "Base", "Gold Vinyl", 1, "N"),
  row(2025, "Panini Prizm", "Base", "White Sparkle", 1, "N"),
];

// ─── Panini Donruss 2023 ──────────────────────────────────────────────────
const donruss2023 = [
  row(2023, "Panini Donruss", "Base", "Holo Red", 2023, "N"),
  row(2023, "Panini Donruss", "Base", "Career Stat Line", 500, "N"),
  row(2023, "Panini Donruss", "Base", "Season Stat Line", 400, "N"),
  row(2023, "Panini Donruss", "Base", "One Hundred", 100, "N"),
  row(2023, "Panini Donruss", "Base", "On Fire", 75, "N"),
  row(2023, "Panini Donruss", "Base", "America", 50, "N"),
  row(2023, "Panini Donruss", "Base", "Presidential Collection", 46, "N"),
  row(2023, "Panini Donruss", "Base", "Voltage", 25, "N"),
  row(2023, "Panini Donruss", "Base", "Artist Proof", 10, "N"),
  row(2023, "Panini Donruss", "Base", "Press Proof", 5, "N"),
  row(2023, "Panini Donruss", "Base", "Holo Gold", 1, "N"),
];

// ─── Panini Donruss 2024 (includes Optic subset) ─────────────────────────
const donruss2024 = [
  row(2024, "Panini Donruss", "Base", "Orange Laser", 299, "N"),
  row(2024, "Panini Donruss", "Base", "Red", 275, "N"),
  row(2024, "Panini Donruss", "Base", "Carolina Blue Laser", 249, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Orange", 199, "N"),
  row(2024, "Panini Donruss", "Base", "Blue", 149, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Lime Green", 149, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Green Velocity", 149, "N"),
  row(2024, "Panini Donruss", "Base", "Purple", 99, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Red", 99, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Pink Velocity", 79, "N"),
  row(2024, "Panini Donruss", "Base", "On Fire", 75, "N"),
  row(2024, "Panini Donruss", "Base", "Pink Laser", 50, "N"),
  row(2024, "Panini Donruss", "Base", "Purple Laser", 49, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Purple", 49, "N"),
  row(2024, "Panini Donruss", "Base", "Presidential Collection", 46, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Black Velocity", 39, "N"),
  row(2024, "Panini Donruss", "Base", "Teal", 25, "N"),
  row(2024, "Panini Donruss", "Base", "Artist Proof", 25, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Cracked Ice", 25, "N"),
  row(2024, "Panini Donruss", "Base", "Gold", 10, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Gold", 10, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Gold Velocity", 10, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Green", 5, "N"),
  row(2024, "Panini Donruss", "Base", "Black", 1, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Gold Vinyl", 1, "N"),
  row(2024, "Panini Donruss", "Base", "Artist Proof Black", 1, "N"),
  row(2024, "Panini Donruss", "Base", "Optic Black Finite", 1, "N"),
];

// ─── Panini Impeccable 2024 (Panini spells it Impeccable, not Immaculate) ─
const impeccable2024 = [
  row(2024, "Panini Impeccable", "Base", "Silver", 60, "N"),
  row(2024, "Panini Impeccable", "Base", "Gold", 30, "N"),
  row(2024, "Panini Impeccable", "Base", "Holo Silver", 25, "N"),
  row(2024, "Panini Impeccable", "Base", "Holo Gold", 10, "N"),
  row(2024, "Panini Impeccable", "Base", "Amethyst", 5, "N"),
  row(2024, "Panini Impeccable", "Base", "Platinum", 1, "N"),
];

// ─── Panini National Treasures 2024 ──────────────────────────────────────
const natTreasures2024 = [
  row(2024, "Panini National Treasures", "Base", "Holo Silver", 25, "N"),
  row(2024, "Panini National Treasures", "Base", "Holo Gold", 10, "N"),
  row(2024, "Panini National Treasures", "Base", "Emerald", 5, "N"),
  row(2024, "Panini National Treasures", "Base", "Platinum", 1, "N"),
];

// ─── Panini Chronicles 2022 ──────────────────────────────────────────────
const chronicles2022 = [
  row(2022, "Panini Chronicles", "Base", "Red", 100, "N"),
  row(2022, "Panini Chronicles", "Base", "Blue", 50, "N"),
  row(2022, "Panini Chronicles", "Base", "Purple", 25, "N"),
  row(2022, "Panini Chronicles", "Base", "Gold", 10, "N"),
  row(2022, "Panini Chronicles", "Base", "Green", 5, "N"),
  row(2022, "Panini Chronicles", "Base", "Black", 1, "N"),
];

// ─── Onyx Vintage 2024 (Base + Mega) ─────────────────────────────────────
const onyx2024 = [
  row(2024, "Onyx Vintage", "Base", "Aqua Border", 150, "N"),
  row(2024, "Onyx Vintage", "Base", "Blue Border", 99, "N"),
  row(2024, "Onyx Vintage", "Base", "Purple Border", 35, "N"),
  row(2024, "Onyx Vintage", "Base", "Silver Border Inscribed", 10, "N"),
  row(2024, "Onyx Vintage", "Mega", "Orange Border", 75, "N"),
  row(2024, "Onyx Vintage", "Mega", "Green Border", 50, "N"),
  row(2024, "Onyx Vintage", "Mega", "Red Border", 25, "N"),
  row(2024, "Onyx Vintage", "Mega", "Nero", 25, "N"),
  row(2024, "Onyx Vintage", "Mega", "Black Border", 5, "N"),
];

// ─── Onyx Vintage Extended 2023 ──────────────────────────────────────────
const onyx2023 = [
  row(2023, "Onyx Vintage", "Base", "Green Signature", 50, "Y"),
  row(2023, "Onyx Vintage", "Base", "Red Signature", 25, "Y"),
  row(2023, "Onyx Vintage", "Base", "Nero Auto", 50, "Y"),
  row(2023, "Onyx Vintage", "Base", "Black Signature", 5, "Y"),
];

const allNew = [
  ...prizm2020,
  ...prizm2021,
  ...prizm2023,
  ...prizm2024,
  ...prizm2025,
  ...donruss2023,
  ...donruss2024,
  ...impeccable2024,
  ...natTreasures2024,
  ...chronicles2022,
  ...onyx2024,
  ...onyx2023,
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
console.log(`[append] appended=${appended} skipped=${skipped}`);
console.log(`[append] final rows=${rows.length}`);

const newSheet = XLSX.utils.json_to_sheet(rows);
wb.Sheets[sheetName] = newSheet;
XLSX.writeFile(wb, outPath);
console.log(`[append] wrote ${outPath}`);
