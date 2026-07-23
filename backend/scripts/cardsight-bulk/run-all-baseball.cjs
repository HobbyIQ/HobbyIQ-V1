#!/usr/bin/env node
// Orchestrator — runs Phases A→B→C→D→E for a given sport (default
// baseball) in order. Each phase can also run independently.
//
// Usage:
//   node run-all-baseball.cjs
//   node run-all-baseball.cjs --sport basketball
//   node run-all-baseball.cjs --sport baseball --min-year 2020 --resume
//   node run-all-baseball.cjs --skip-pricing --skip-marketplace
//   node run-all-baseball.cjs --dry-run

const { spawnSync } = require("child_process");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

function passthrough() {
  // Everything except phase-specific --skip-* flags
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--skip-pricing" || a === "--skip-population" ||
        a === "--skip-calendar" || a === "--skip-marketplace" ||
        a === "--skip-catalog") continue;
    out.push(a);
  }
  return out;
}

function runPhase(scriptName, extraArgs = []) {
  const script = path.join(__dirname, scriptName);
  const args = [script, ...passthrough(), ...extraArgs];
  console.log(`\n=== ${scriptName} ${args.slice(1).join(" ")} ===`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`  ${scriptName} exited ${r.status}`);
    process.exit(r.status || 1);
  }
}

function main() {
  const skip = {
    catalog: flag("skip-catalog"),
    pricing: flag("skip-pricing"),
    population: flag("skip-population"),
    calendar: flag("skip-calendar"),
    marketplace: flag("skip-marketplace"),
  };
  console.log(`[run-all] skip=${JSON.stringify(skip)}`);
  const t0 = Date.now();

  if (!skip.catalog) {
    runPhase("phase-a-crawl-releases.cjs");
    runPhase("phase-a-crawl-cards.cjs");
  }
  if (!skip.pricing) runPhase("phase-b-crawl-pricing.cjs");
  if (!skip.population) runPhase("phase-c-crawl-population.cjs");
  if (!skip.calendar) runPhase("phase-d-crawl-release-calendar.cjs");
  if (!skip.marketplace) runPhase("phase-e-crawl-marketplace.cjs");

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[run-all] complete in ${total}s`);
}

main();
