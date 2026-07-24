#!/usr/bin/env node
// Full-catalog orchestrator — runs baseball, basketball, football (default)
// through Phases A→B→C→D→E in sequence. Optimized for Cloud Shell /
// same-region Azure runs where Cosmos writes are ~2-5ms.
//
// Usage (from Cloud Shell):
//   node backend/scripts/cardsight-bulk/run-all-sports.cjs
//   node backend/scripts/cardsight-bulk/run-all-sports.cjs --sports baseball,basketball,football,pokemon
//   node backend/scripts/cardsight-bulk/run-all-sports.cjs --skip-marketplace --skip-population
//   node backend/scripts/cardsight-bulk/run-all-sports.cjs --min-year 2018
//
// Flags forwarded to every phase: --min-year, --year, --resume, --dry-run
// Phase skip flags: --skip-catalog, --skip-pricing, --skip-population,
//                   --skip-calendar, --skip-marketplace

const { spawnSync } = require("child_process");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const PASSTHROUGH_ARGS = ["--min-year", "--year", "--resume", "--dry-run", "--level", "--limit-cards", "--period", "--listing-type"];
function passthrough() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--sports") { i++; continue; }                     // consumed here
    if (a.startsWith("--skip-")) continue;                        // phase gates
    // pass through everything else (--min-year <val>, --year <val>, etc.)
    out.push(a);
  }
  return out;
}

function run(script, extra = []) {
  const scriptPath = path.join(__dirname, script);
  const args = [scriptPath, ...passthrough(), ...extra];
  console.log(`\n=== ${script} ${extra.join(" ")} ===`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`  ${script} exited ${r.status} after ${s}s`);
    return false;
  }
  console.log(`  ${script} done in ${s}s`);
  return true;
}

function main() {
  const sports = (arg("sports", "baseball,basketball,football")).split(",").map((s) => s.trim()).filter(Boolean);
  const skip = {
    catalog: flag("skip-catalog"),
    pricing: flag("skip-pricing"),
    population: flag("skip-population"),
    calendar: flag("skip-calendar"),
    marketplace: flag("skip-marketplace"),
  };
  console.log(`[run-all-sports] sports=${sports.join(",")} skip=${JSON.stringify(skip)}`);
  const t0 = Date.now();

  for (const sport of sports) {
    console.log(`\n########## ${sport.toUpperCase()} ##########`);
    if (!skip.catalog) {
      if (!run("phase-a-crawl-releases.cjs", ["--sport", sport])) continue;
      if (!run("phase-a-crawl-cards.cjs", ["--sport", sport])) continue;
    }
    if (!skip.pricing)    run("phase-b-crawl-pricing.cjs", ["--sport", sport]);
    if (!skip.population) run("phase-c-crawl-population.cjs", ["--sport", sport]);
    if (!skip.calendar)   run("phase-d-crawl-release-calendar.cjs", ["--sport", sport]);
    if (!skip.marketplace) run("phase-e-crawl-marketplace.cjs", ["--sport", sport]);
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[run-all-sports] complete in ${total}s`);
}

main();
