#!/usr/bin/env node
// CF-COMP-QUALITY-LOOP (Drew, 2026-07-24). Autonomous cleanup loop that
// chains all comp-quality normalization + flagging passes over sold_comps.
// Runs until either (a) N passes yield zero changes (converged) or
// (b) MAX_ITERATIONS reached (safety cap).
//
// Each pass runs, in order:
//   1. isAuto backfill (all sports/years)
//   2. missing-slug recompute (all sports/years)
//   3. cardNumber normalize (all sports/years)
//   4. quality flagger (baseball 2020+ — Cosmos limit heavy on wider scope)
//   5. empty-setKey consolidation
//
// Between passes, sleeps PASS_SLEEP_MS to let Cosmos throughput recover.
// Idempotent — passes 2+ do far less work than pass 1.
//
// Env:
//   MAX_ITERATIONS=20     — safety cap on total passes
//   PASS_SLEEP_MS=30000   — sleep between passes
//   MAX_DURATION_MIN=360  — hard time cap (6 hours default)
//
// Usage:
//   RECOMPUTE_APPLY=true ISAUTO_APPLY=true NORM_CARDNUMBER_APPLY=true \
//   FLAG_APPLY=true EMPTY_SETKEY_APPLY=true \
//   node backend/scripts/comp-quality/run-cleanup-loop.cjs

const { spawnSync } = require("child_process");
const path = require("path");

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS || "20");
const PASS_SLEEP_MS = Number(process.env.PASS_SLEEP_MS || "30000");
const MAX_DURATION_MIN = Number(process.env.MAX_DURATION_MIN || "360");

const STEPS = [
  { name: "isAuto", script: "backfill-isauto-from-cardnumber.cjs", args: ["--all"] },
  { name: "missing-slug", script: "sold-comps-missing-slug-recompute.cjs", args: ["--all"] },
  { name: "cardNumber-norm", script: "normalize-cardnumber.cjs", args: ["--all"] },
  { name: "flagger", script: "flag-comp-quality.cjs", args: ["--sport", "baseball", "--min-year", "2020"] },
  { name: "empty-setKey", script: "consolidate-empty-setkey-slugs.cjs", args: ["--sport", "baseball", "--min-year", "2020"] },
];

function runStep(step) {
  const script = path.join(__dirname, step.script);
  const args = [script, ...step.args];
  console.log(`\n--- ${step.name} ---`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) console.warn(`  ${step.name} exited ${r.status} after ${s}s`);
  else console.log(`  ${step.name} done in ${s}s`);
  return r.status === 0;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`[cleanup-loop] MAX_ITERATIONS=${MAX_ITERATIONS} PASS_SLEEP=${PASS_SLEEP_MS}ms MAX_DURATION=${MAX_DURATION_MIN}min`);
  console.log(`[cleanup-loop] starting at ${new Date().toISOString()}\n`);
  const startTime = Date.now();

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const elapsedMin = (Date.now() - startTime) / 60_000;
    if (elapsedMin >= MAX_DURATION_MIN) {
      console.log(`\n[cleanup-loop] hit MAX_DURATION_MIN (${MAX_DURATION_MIN}min). Stopping.`);
      break;
    }
    console.log(`\n========== iteration ${iter}/${MAX_ITERATIONS} (elapsed ${elapsedMin.toFixed(1)}min) ==========`);
    for (const step of STEPS) {
      runStep(step);
    }
    console.log(`\n[cleanup-loop] iteration ${iter} complete. sleeping ${PASS_SLEEP_MS}ms...`);
    await sleep(PASS_SLEEP_MS);
  }
  const totalMin = ((Date.now() - startTime) / 60_000).toFixed(1);
  console.log(`\n[cleanup-loop] done. total elapsed: ${totalMin} min`);
}
main().catch(e => { console.error(e); process.exit(1); });
