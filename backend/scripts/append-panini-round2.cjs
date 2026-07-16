#!/usr/bin/env node
/**
 * CF-PANINI-HISTORIC-GAP-FILL-R2 (2026-07-11, Drew).
 *
 * Round 2 additions. Sources: BaseballCardPedia + Beckett + Cardboard
 * Connection + Cardsmiths + Cardlines. Every row cross-verified.
 *
 * Products covered:
 *   * Panini Donruss Optic 2022
 *   * Panini Prizm Draft Picks 2020
 *   * Panini Diamond Kings 2022
 *   * Panini Mosaic 2022
 *   * Panini Select 2023-2024
 *   * Panini Flawless 2022-2023 (variant thresholds)
 *   * Panini National Treasures 2023
 */

const XLSX = require("xlsx");

const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error("Usage: node append-panini-round2.cjs <input.xlsx> <output.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(srcPath);
const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "master") ?? wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
console.log(`[append r2] existing sheet=${sheetName} rows=${rows.length}`);

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

const src = "BaseballCardPedia + Beckett + Cardboard Connection (Panini round 2, 2026-07-11)";

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

// ─── 2022 Donruss Optic ───────────────────────────────────────────────────
const optic2022 = [
  row(2022, "Donruss Optic", "Base", "Pink Velocity", 249, "N"),
  row(2022, "Donruss Optic", "Base", "Red White & Blue", 199, "N"),
  row(2022, "Donruss Optic", "Base", "Black Stars", 149, "N"),
  row(2022, "Donruss Optic", "Base", "Orange", 125, "N"),
  row(2022, "Donruss Optic", "Base", "Blue Velocity", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Green Dragon", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Pandora", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Pandora Blue", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Pandora Purple", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Pandora Red", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Red Dragon", 99, "N"),
  row(2022, "Donruss Optic", "Base", "Spirit of '76", 76, "N"),
  row(2022, "Donruss Optic", "Base", "Blue", 75, "N"),
  row(2022, "Donruss Optic", "Base", "Red", 60, "N"),
  row(2022, "Donruss Optic", "Base", "Carolina Blue", 50, "N"),
  row(2022, "Donruss Optic", "Base", "Freedom", 46, "N"),
  row(2022, "Donruss Optic", "Base", "Teal Velocity", 35, "N"),
  row(2022, "Donruss Optic", "Base", "Black", 25, "N"),
  row(2022, "Donruss Optic", "Base", "Liberty", 25, "N"),
  row(2022, "Donruss Optic", "Base", "Gold", 10, "N"),
  row(2022, "Donruss Optic", "Base", "Cracked Ice Blue", 7, "N"),
  row(2022, "Donruss Optic", "Base", "Cracked Ice Green", 7, "N"),
  row(2022, "Donruss Optic", "Base", "Cracked Ice Red", 7, "N"),
  row(2022, "Donruss Optic", "Base", "Green", 5, "N"),
  row(2022, "Donruss Optic", "Base", "Black Finite", 1, "N"),
  row(2022, "Donruss Optic", "Base", "Eagle", 1, "N"),
  row(2022, "Donruss Optic", "Base", "Gold Vinyl", 1, "N"),
];

// ─── 2020 Panini Prizm Draft Picks ───────────────────────────────────────
const prizmDraft2020 = [
  row(2020, "Panini Prizm Draft Picks", "Base", "Tiger Stripes", 99, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Lime Green", 75, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Neon Orange", 50, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Power Plaid", 35, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Snake Skin", 25, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Burgundy Cracked Ice", 23, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Navy Blue Kaleidoscope", 15, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Gold", 10, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Black Finite", 1, "N"),
  row(2020, "Panini Prizm Draft Picks", "Base", "Gold Vinyl", 1, "N"),
  row(2020, "Panini Prizm Draft Picks", "Donut Circle", "Red", 99, "N"),
  row(2020, "Panini Prizm Draft Picks", "Donut Circle", "White", 50, "N"),
  row(2020, "Panini Prizm Draft Picks", "Donut Circle", "Blue", 25, "N"),
];

// ─── 2022 Panini Diamond Kings ───────────────────────────────────────────
const dk2022 = [
  row(2022, "Panini Diamond Kings", "Base", "Artist Proof Silver", 99, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Artist Proof Gold", 49, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Green Frame", 25, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Antique Frame", 18, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Antique Frame Masterpiece", 1, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Black Frame Masterpiece", 1, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Gray Frame Masterpiece", 1, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Green Frame Masterpiece", 1, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Masterpiece", 1, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Plum Frame Masterpiece", 1, "N"),
  row(2022, "Panini Diamond Kings", "Base", "Red Frame Masterpiece", 1, "N"),
];

// ─── 2022 Panini Mosaic ───────────────────────────────────────────────────
const mosaic2022 = [
  row(2022, "Panini Mosaic", "Base", "Blue", 99, "N"),
  row(2022, "Panini Mosaic", "Base", "Purple", 49, "N"),
  row(2022, "Panini Mosaic", "Base", "Orange Fluorescent", 25, "N"),
  row(2022, "Panini Mosaic", "Base", "White", 25, "N"),
  row(2022, "Panini Mosaic", "Base", "Blue Fluorescent", 15, "N"),
  row(2022, "Panini Mosaic", "Base", "Green Swirl", 12, "N"),
  row(2022, "Panini Mosaic", "Base", "Pink Swirl", 12, "N"),
  row(2022, "Panini Mosaic", "Base", "Gold", 10, "N"),
  row(2022, "Panini Mosaic", "Base", "Green Fluorescent", 10, "N"),
  row(2022, "Panini Mosaic", "Base", "Pink Fluorescent", 10, "N"),
  row(2022, "Panini Mosaic", "Base", "Black", 1, "N"),
  row(2022, "Panini Mosaic", "Choice", "Black/Gold", 8, "N"),
  row(2022, "Panini Mosaic", "Choice", "Nebula", 1, "N"),
];

// ─── 2023 Panini Select ───────────────────────────────────────────────────
const select2023 = [
  row(2023, "Panini Select", "Base", "Silver", 99, "N"),
  row(2023, "Panini Select", "Base", "Tri-Color", 49, "N"),
  row(2023, "Panini Select", "Base", "Cracked Ice", 23, "N"),
  row(2023, "Panini Select", "Base", "Gold", 10, "N"),
  row(2023, "Panini Select", "Base", "Neon Orange Pulsar", 3, "N"),
  row(2023, "Panini Select", "Base", "Black Finite", 1, "N"),
  row(2023, "Panini Select", "Base", "Gold Vinyl", 1, "N"),
];

// ─── 2024 Panini Select ───────────────────────────────────────────────────
const select2024 = [
  row(2024, "Panini Select", "Base", "Light Blue Prizms", 199, "N"),
  row(2024, "Panini Select", "Base", "Red Prizms", 149, "N"),
  row(2024, "Panini Select", "Base", "White Prizms", 99, "N"),
  row(2024, "Panini Select", "Base", "Black & Blue Prizms", 49, "N"),
  row(2024, "Panini Select", "Base", "Neon Green Prizms", 49, "N"),
  row(2024, "Panini Select", "Base", "Tie-Dye Prizms", 25, "N"),
  row(2024, "Panini Select", "Base", "Gold Flash Prizms", 10, "N"),
  row(2024, "Panini Select", "Base", "Gold Prizms", 10, "N"),
  row(2024, "Panini Select", "Base", "Mojo Prizms FOTL", 6, "N"),
  row(2024, "Panini Select", "Base", "Green Prizms", 5, "N"),
  row(2024, "Panini Select", "Base", "Black Finite Prizms", 1, "N"),
  row(2024, "Panini Select", "Base", "Gold Vinyl Prizms", 1, "N"),
];

// ─── 2022 & 2023 Panini Flawless ─────────────────────────────────────────
// Note: base card /20; parallels are Yellow Diamond /10, Emerald /5, Sapphire /3, Pink /2, Platinum /1
const flawless22_23 = [];
for (const year of [2022, 2023]) {
  flawless22_23.push(row(year, "Panini Flawless", "Base", "Yellow Diamond", 10, "N"));
  flawless22_23.push(row(year, "Panini Flawless", "Base", "Emerald", 5, "N"));
  flawless22_23.push(row(year, "Panini Flawless", "Base", "Sapphire", 3, "N"));
  flawless22_23.push(row(year, "Panini Flawless", "Base", "Pink", 2, "N"));
  flawless22_23.push(row(year, "Panini Flawless", "Base", "Platinum", 1, "N"));
}

// ─── 2023 Panini National Treasures ──────────────────────────────────────
const natTr2023 = [
  row(2023, "Panini National Treasures", "Base", "Gold", 49, "N"),
  row(2023, "Panini National Treasures", "Base", "Holo Gold", 25, "N"),
  row(2023, "Panini National Treasures", "Base", "Holo Silver", 10, "N"),
  row(2023, "Panini National Treasures", "Base", "Purple", 3, "N"),
  row(2023, "Panini National Treasures", "Base", "Platinum", 1, "N"),
  row(2023, "Panini National Treasures", "Base", "Laundry Tag", 1, "N"),
  row(2023, "Panini National Treasures", "Base", "Brand Logo", 1, "N"),
];

const allNew = [
  ...optic2022,
  ...prizmDraft2020,
  ...dk2022,
  ...mosaic2022,
  ...select2023,
  ...select2024,
  ...flawless22_23,
  ...natTr2023,
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
console.log(`[append r2] appended=${appended} skipped=${skipped}`);
console.log(`[append r2] final rows=${rows.length}`);

const newSheet = XLSX.utils.json_to_sheet(rows);
wb.Sheets[sheetName] = newSheet;
XLSX.writeFile(wb, outPath);
console.log(`[append r2] wrote ${outPath}`);
