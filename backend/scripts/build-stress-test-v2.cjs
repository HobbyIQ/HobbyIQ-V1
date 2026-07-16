#!/usr/bin/env node
/**
 * CF-STRESS-TEST-V2 (2026-07-11, Drew).
 *
 * Builds a synthetic Bowman-family stress-test workbook using
 * PRODUCT-SPECIFIC parallel schemes. Replaces v1's uniform-matrix
 * approach that mis-modeled reality (v1 applied "Speckle" and
 * "Blue Wave" to flagship Bowman where those parallels don't exist).
 *
 * v2 schemes are drawn from BaseballCardPedia + Beckett + Cardboard
 * Connection research; each product-year matrix reflects the parallels
 * that ACTUALLY exist in that release, so a v2 coverage % against
 * the reference-catalog measures TRUE ladder completeness rather
 * than being poisoned by synthetic mis-alignments.
 *
 * Runbook:
 *   node scripts/build-stress-test-v2.cjs <output.xlsx>
 */

const XLSX = require("xlsx");

const [outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("Usage: node build-stress-test-v2.cjs <output.xlsx>");
  process.exit(1);
}

// ─── Product-specific parallel schemes ─────────────────────────────────────

// Flagship Bowman base parallels (paper — not Chrome).
// Same core scheme 2022-2025 with a few year-to-year variations noted.
const FLAGSHIP_BOWMAN_BASE = [
  { parallel: "Sky Blue", printRun: 499, auto: false },
  { parallel: "Neon Green", printRun: 399, auto: false },
  { parallel: "Fuchsia", printRun: 299, auto: false },
  { parallel: "Purple", printRun: 250, auto: false },
  { parallel: "Purple Pattern", printRun: 199, auto: false },
  { parallel: "Pink", printRun: 175, auto: false },
  { parallel: "Blue", printRun: 150, auto: false },
  { parallel: "Blue Pattern", printRun: 150, auto: false }, // /150 per BCP 2022, 2025, 2026 (2023,2024 was /125)
  { parallel: "Green", printRun: 99, auto: false },
  { parallel: "Green Pattern", printRun: 99, auto: false },
  { parallel: "Yellow", printRun: 75, auto: false },
  { parallel: "Gold", printRun: 50, auto: false },
  { parallel: "Orange", printRun: 25, auto: false },
  { parallel: "Red", printRun: 5, auto: false },
  { parallel: "Platinum", printRun: 1, auto: false },
];

// Bowman Chrome — core scheme for Chrome Prospects.
const BWC_PROSPECTS = [
  { parallel: "Refractor", printRun: 499, auto: false },
  { parallel: "Lava Refractor", printRun: 399, auto: false },
  { parallel: "Speckle Refractor", printRun: 299, auto: false },
  { parallel: "Purple Refractor", printRun: 250, auto: false },
  { parallel: "Purple RayWave Refractor", printRun: 250, auto: false },
  { parallel: "Fuchsia Refractor", printRun: 199, auto: false },
  { parallel: "Blue Refractor", printRun: 150, auto: false },
  { parallel: "Blue RayWave Refractor", printRun: 150, auto: false },
  { parallel: "Blue Shimmer Refractor", printRun: 150, auto: false },
  { parallel: "Aqua Shimmer Refractor", printRun: 125, auto: false },
  { parallel: "Green Refractor", printRun: 99, auto: false },
  { parallel: "Yellow Refractor", printRun: 75, auto: false },
  { parallel: "Gold Refractor", printRun: 50, auto: false },
  { parallel: "Gold Shimmer Refractor", printRun: 50, auto: false },
  { parallel: "Orange Refractor", printRun: 25, auto: false },
  { parallel: "Rose Gold Refractor", printRun: 10, auto: false },
  { parallel: "Red Refractor", printRun: 5, auto: false },
  { parallel: "SuperFractor", printRun: 1, auto: false },
];

// Bowman Chrome — Chrome Prospect Autographs.
const BWC_PROSPECT_AUTOS = [
  { parallel: "Refractor", printRun: 499, auto: true },
  { parallel: "Speckle Refractor", printRun: 299, auto: true },
  { parallel: "Purple Refractor", printRun: 250, auto: true },
  { parallel: "Blue Refractor", printRun: 150, auto: true },
  { parallel: "Blue RayWave Refractor", printRun: 150, auto: true },
  { parallel: "Green Refractor", printRun: 99, auto: true },
  { parallel: "Yellow Refractor", printRun: 75, auto: true },
  { parallel: "Gold Refractor", printRun: 50, auto: true },
  { parallel: "Orange Refractor", printRun: 25, auto: true },
  { parallel: "Red Refractor", printRun: 5, auto: true },
  { parallel: "SuperFractor", printRun: 1, auto: true },
];

// Bowman Draft — Chrome Prospects (core scheme; older years differ).
const BWD_PROSPECTS = [
  { parallel: "Refractor", printRun: 499, auto: false },
  { parallel: "Purple Refractor", printRun: 250, auto: false },
  { parallel: "Aqua Lava Refractor", printRun: 199, auto: false },
  { parallel: "Blue Refractor", printRun: 150, auto: false },
  { parallel: "Green Refractor", printRun: 99, auto: false },
  { parallel: "Yellow Refractor", printRun: 75, auto: false },
  { parallel: "Gold Refractor", printRun: 50, auto: false },
  { parallel: "Orange Refractor", printRun: 25, auto: false },
  { parallel: "Red Refractor", printRun: 5, auto: false },
  { parallel: "SuperFractor", printRun: 1, auto: false },
];

// Bowman Draft — Chrome Autographs.
const BWD_AUTOS = [
  { parallel: "Refractor", printRun: 499, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Purple Refractor", printRun: 250, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Blue Refractor", printRun: 150, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Blue Wave Refractor", printRun: 150, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Green Refractor", printRun: 99, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Gold Refractor", printRun: 50, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Orange Refractor", printRun: 25, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "Red Refractor", printRun: 5, auto: true, cardSet: "Chrome Autographs" },
  { parallel: "SuperFractor", printRun: 1, auto: true, cardSet: "Chrome Autographs" },
];

// ─── 2022 Bowman Chrome uses SHIMMER scheme, not RayWave (introduced 2023) ─
const BWC_PROSPECTS_2022 = [
  { parallel: "Refractor", printRun: 499, auto: false },
  { parallel: "Speckle Refractor", printRun: 299, auto: false },
  { parallel: "Purple Shimmer Refractor", printRun: 250, auto: false },
  { parallel: "Purple Refractor", printRun: 250, auto: false },
  { parallel: "Fuchsia Shimmer Refractor", printRun: 199, auto: false },
  { parallel: "Blue Refractor", printRun: 150, auto: false },
  { parallel: "Aqua Refractor", printRun: 125, auto: false },
  { parallel: "Green Shimmer Refractor", printRun: 99, auto: false },
  { parallel: "Green Refractor", printRun: 99, auto: false },
  { parallel: "Yellow Refractor", printRun: 75, auto: false },
  { parallel: "Gold Shimmer Refractor", printRun: 50, auto: false },
  { parallel: "Gold Refractor", printRun: 50, auto: false },
  { parallel: "Orange Shimmer Refractor", printRun: 25, auto: false },
  { parallel: "Orange Refractor", printRun: 25, auto: false },
  { parallel: "Red Shimmer Refractor", printRun: 5, auto: false },
  { parallel: "Red Refractor", printRun: 5, auto: false },
  { parallel: "Black Shimmer Refractor", printRun: 1, auto: false },
  { parallel: "SuperFractor", printRun: 1, auto: false },
];

// ─── 2022 flagship Bowman didn't have Pink (introduced 2023) ─────────────
const FLAGSHIP_BOWMAN_BASE_2022 = FLAGSHIP_BOWMAN_BASE.filter((p) => p.parallel !== "Pink");

function schemeFor(product, cardSet, year) {
  if (product === "Bowman" && cardSet === "Base") {
    const scheme = year === 2022 ? FLAGSHIP_BOWMAN_BASE_2022 : FLAGSHIP_BOWMAN_BASE;
    return scheme.map((p) => ({ ...p, cardSet: "Base" }));
  }
  if (product === "Bowman Chrome" && cardSet === "Chrome Prospects") {
    const scheme = year === 2022 ? BWC_PROSPECTS_2022 : BWC_PROSPECTS;
    return scheme.map((p) => ({ ...p, cardSet: "Chrome Prospects" }));
  }
  if (product === "Bowman Chrome" && cardSet === "Chrome Prospect Autographs") return BWC_PROSPECT_AUTOS.map((p) => ({ ...p, cardSet: "Chrome Prospect Autographs" }));
  if (product === "Bowman Draft" && cardSet === "Chrome Prospects") return BWD_PROSPECTS.map((p) => ({ ...p, cardSet: "Chrome Prospects" }));
  if (product === "Bowman Draft" && cardSet === "Chrome Autographs") return BWD_AUTOS.map((p) => ({ ...p }));
  return [];
}

// ─── Card synthesizer ─────────────────────────────────────────────────────

const CARDS_PER_SUBJECT_PER_PARALLEL = 5;
const SUBJECTS_PER_SET = 100;

function synthesizeCards(year, product, cardSet, parallelsScheme) {
  const cards = [];
  for (let subject = 1; subject <= SUBJECTS_PER_SET; subject++) {
    const playerName = `TestPlayer ${year}-${product.replace(/\s+/g, "")}-${String(subject).padStart(3, "0")}`;
    for (const p of parallelsScheme) {
      for (let sample = 1; sample <= CARDS_PER_SUBJECT_PER_PARALLEL; sample++) {
        cards.push({
          Year: year,
          Name: playerName,
          Set: product,
          "Card Set": cardSet,
          Parallel: p.parallel,
          "Auto Y/N": p.auto ? "Y" : "N",
          "Card Number": `BCP-${subject}`,
          "Serial Number": p.printRun ?? "",
          "Card Type": cardSet,
          Sample: sample,
          "Test Record Y/N": "Y",
        });
      }
    }
  }
  return cards;
}

// ─── Build the matrix ─────────────────────────────────────────────────────

const MATRIX = [
  // (year, product, cardSet)
  [2022, "Bowman", "Base"],
  [2023, "Bowman", "Base"],
  [2024, "Bowman", "Base"],
  [2025, "Bowman", "Base"],
  [2026, "Bowman", "Base"],
  [2022, "Bowman Chrome", "Chrome Prospects"],
  [2022, "Bowman Chrome", "Chrome Prospect Autographs"],
  [2023, "Bowman Chrome", "Chrome Prospects"],
  [2023, "Bowman Chrome", "Chrome Prospect Autographs"],
  [2024, "Bowman Chrome", "Chrome Prospects"],
  [2024, "Bowman Chrome", "Chrome Prospect Autographs"],
  [2025, "Bowman Chrome", "Chrome Prospects"],
  [2025, "Bowman Chrome", "Chrome Prospect Autographs"],
  [2022, "Bowman Draft", "Chrome Prospects"],
  [2022, "Bowman Draft", "Chrome Autographs"],
  [2023, "Bowman Draft", "Chrome Prospects"],
];

const allCards = [];
const parallelInventory = [];
for (const [year, product, cardSet] of MATRIX) {
  const scheme = schemeFor(product, cardSet, year);
  if (scheme.length === 0) continue;
  const cards = synthesizeCards(year, product, cardSet, scheme);
  allCards.push(...cards);
  for (const p of scheme) {
    parallelInventory.push({
      Year: year,
      Product: product,
      "Card Set": cardSet,
      Parallel: p.parallel,
      "Print Run": p.printRun ?? "",
      Auto: p.auto ? "Y" : "N",
    });
  }
}

console.log(`[stress-v2] synthesized ${allCards.length} test cards across ${MATRIX.length} (product, year, set) combos`);
console.log(`[stress-v2] ${parallelInventory.length} unique parallel entries in inventory`);

// ─── Build the workbook ───────────────────────────────────────────────────

const wb = XLSX.utils.book_new();

const readmeRows = [
  ["Bowman Pricing Stress-Test Dataset v2", ""],
  ["Purpose", "Reflects PRODUCT-SPECIFIC parallel schemes drawn from real hobby releases (BaseballCardPedia + Beckett)."],
  ["Coverage", `${MATRIX.length} (product, year, set) combos across Bowman flagship, Bowman Chrome, Bowman Draft 2022-2026.`],
  ["Card count", `${allCards.length} synthetic test cards.`],
  ["Naming", "Parallel names match the reference-catalog convention exactly (e.g. 'Blue RayWave Refractor', 'Speckle Refractor')."],
  ["Superseded", "Bowman_2022_2026_Pricing_Stress_Test.xlsx (v1 used a uniform 21-parallel matrix that mis-modeled flagship + Draft parallel schemes)."],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readmeRows), "README");

const cardsSheet = XLSX.utils.json_to_sheet(allCards);
XLSX.utils.book_append_sheet(wb, cardsSheet, "Cards");

const inventorySheet = XLSX.utils.json_to_sheet(parallelInventory);
XLSX.utils.book_append_sheet(wb, inventorySheet, "Parallel Inventory");

XLSX.writeFile(wb, outPath);
console.log(`[stress-v2] wrote ${outPath}`);
