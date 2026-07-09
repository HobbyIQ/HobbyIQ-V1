#!/usr/bin/env node
/**
 * CF-PARALLEL-FLOOR-AUDIT (2026-07-08, Drew):
 *
 * Audits `data/parallel-premiums-latest.json` against the print-run
 * floor rules in `src/services/compiq/parallelPremiumFloors.ts`.
 * Reports parallels that have real empirical trading data but NO
 * floor tier assigned — those are the cards we'd currently under-
 * price (or fail to price) when the empirical entry doesn't apply.
 *
 * Run this after any calibration merge to see coverage gaps:
 *   node backend/scripts/audit-parallel-floor-coverage.cjs
 *
 * Threshold: only reports parallels with >=3 empirical entries so
 * we don't drown in one-off calibration rows. Lower via env:
 *   MIN_EMPIRICAL_ENTRIES=1 node backend/scripts/audit-parallel-floor-coverage.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

// Mirror inferPrintRun logic from parallelPremiumFloors.ts. Kept in
// sync manually — the audit is a diagnostic script, not a hot path,
// so duplication beats a require of the compiled dist output.
function inferPrintRun(parallelName) {
  if (!parallelName || typeof parallelName !== "string") return null;
  const n = parallelName.trim().toLowerCase();
  // 1/1s
  if (n.includes("superfractor")) return 1;
  if (n.includes("printing plate") || n.includes("printing-plate")) return 1;
  // Panini Prizm family
  if (n === "nebula prizm" || n === "nebula") return 1;
  if (n.includes("black finite") || n === "black prizm") return 1;
  if (n === "gold vinyl" || n.includes("gold vinyl")) return 5;
  if (n === "gold prizm" || (n.startsWith("gold ") && n.includes("prizm"))) return 10;
  if (n === "camo prizm" || n === "camo") return 25;
  if (n === "mojo prizm" || n === "mojo") return 25;
  if (n === "blue ice" || n.includes("blue ice")) return 75;
  if (n === "purple prizm" || (n.startsWith("purple ") && n.includes("prizm"))) return 75;
  if (n === "hyper prizm" || n === "hyper") return 275;
  if (n === "red prizm" || (n.startsWith("red ") && n.includes("prizm"))) return 299;
  if (n === "silver prizm" || n === "silver") return 500;
  if (n === "green prizm") return 500;
  // Bowman/Topps retail snackpack family
  if (n.includes("gum ball") || n.includes("bubblegum") || n.includes("bubble gum") || n.includes("snackpack")) return 5;
  if (n.includes("peanuts")) return 5;
  if (n.includes("sunflower seeds") || n.includes("sunflower seed")) return 5;
  if (n.includes("logofractor") || n.includes("logo fractor")) return 35;
  if (n.includes("black x-fractor") || n.includes("black xfractor")) return 10;
  if (n === "black" || (n.startsWith("black ") && n.includes("refractor"))) return 10;
  // Batch 3 (2026-07-08): Bowman single-color autos + Mini-Diamond + Sparkle + Speckle
  if (n === "green") return 99;
  if (n === "purple") return 250;
  if (n === "mini-diamond" || n === "mini diamond" || n.includes("mini-diamond refractor") || n.includes("mini diamond refractor")) return 100;
  if (n === "sparkle" || n.includes("sparkle refractor")) return 299;
  if (n === "speckle" || n.includes("speckle refractor")) return 299;
  // Bowman/Topps refractor family
  if (n === "red" || n.startsWith("red ")) return 5;
  if (n.includes("red refractor") || n.includes("red x-fractor")) return 5;
  if (n.includes("orange refractor") && !n.includes("shimmer")) return 25;
  if (n === "orange" || n.startsWith("orange ")) return 25;
  if (n.includes("orange x-fractor")) return 25;
  if (n.includes("orange shimmer")) return 10;
  if (n === "gold" || n.startsWith("gold ")) return 50;
  if (n.includes("gold refractor") || n.includes("gold x-fractor")) return 50;
  if (n.includes("aqua")) return 75;
  if (n.includes("purple refractor") || n.includes("purple x-fractor")) return 250;
  if (n === "blue" || n.startsWith("blue ")) return 150;
  if (n.includes("blue refractor") || n.includes("blue x-fractor")) return 150;
  if (n.includes("green refractor") || n.includes("green x-fractor")) return 499;
  return null;
}

const MIN_ENTRIES = parseInt(process.env.MIN_EMPIRICAL_ENTRIES || "3", 10);
const MIN_SAMPLE = 5;

const tablePath = path.resolve(__dirname, "..", "data", "parallel-premiums-latest.json");
if (!fs.existsSync(tablePath)) {
  console.error(`Cannot find ${tablePath}`);
  process.exit(1);
}
const table = JSON.parse(fs.readFileSync(tablePath, "utf8"));

const byParallel = new Map();
for (const e of table.entries || []) {
  const key = e.parallel;
  if (!byParallel.has(key)) byParallel.set(key, []);
  byParallel.get(key).push(e);
}

const missed = [];
const covered = [];
for (const [parallel, entries] of byParallel.entries()) {
  const empirical = entries.filter((e) => (e.sampleSize ?? 0) >= MIN_SAMPLE).length;
  if (empirical === 0) continue;
  const pr = inferPrintRun(parallel);
  const bestEntry = entries.slice().sort((a, b) => (b.sampleSize ?? 0) - (a.sampleSize ?? 0))[0];
  const rec = {
    parallel,
    printRun: pr,
    empiricalConfigs: empirical,
    topN: bestEntry?.sampleSize ?? 0,
    topPremium: bestEntry?.baseRelativePremium ?? null,
    topContext: `${bestEntry?.year} ${bestEntry?.set} isAuto=${bestEntry?.isAuto}`,
  };
  (pr === null ? missed : covered).push(rec);
}

missed.sort((a, b) => b.empiricalConfigs - a.empiricalConfigs);
covered.sort((a, b) => b.empiricalConfigs - a.empiricalConfigs);

console.log(`Parallel table entries: ${(table.entries || []).length}`);
console.log(`Unique parallel names: ${byParallel.size}`);
console.log(`With empirical data (>=${MIN_SAMPLE} samples): ${missed.length + covered.length}`);
console.log(`  Covered by inferPrintRun: ${covered.length}`);
console.log(`  MISSED (no floor tier): ${missed.length}`);
console.log();
console.log(`=== MISSED (>=${MIN_ENTRIES} empirical configs, sorted by count) ===`);
console.log(
  "parallel".padEnd(44) +
  "cfg " +
  "top_n ".padStart(6) +
  "prem".padStart(9) +
  "  top_context",
);
for (const m of missed.filter((x) => x.empiricalConfigs >= MIN_ENTRIES)) {
  console.log(
    m.parallel.padEnd(44) +
    String(m.empiricalConfigs).padStart(3) + " " +
    String(m.topN).padStart(6) +
    String(m.topPremium).padStart(9) +
    "  " + m.topContext,
  );
}
console.log();
console.log(`Total missed shown: ${missed.filter((x) => x.empiricalConfigs >= MIN_ENTRIES).length}`);
console.log(`(Threshold: MIN_EMPIRICAL_ENTRIES=${MIN_ENTRIES}; MIN_SAMPLE=${MIN_SAMPLE})`);
