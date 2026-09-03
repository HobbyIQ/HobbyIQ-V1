#!/usr/bin/env node
/**
 * CF-MARKET-INDEXES (Drew, 2026-09-02). Nightly: recompute each sport's
 * fixed-liquid-basket index and append today's point. On the first run
 * (or with --backfill) it builds the full 180d history from stored
 * sales instead of just today.
 *
 * Methodology + storage rationale: see
 * backend/src/services/insights/marketIndex.service.ts header.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/compute-market-indexes.cjs [--backfill]
 *
 * Flags:
 *   --backfill      Compute the full 180d window (first-run history).
 *   --as-of=DATE    Target day, YYYY-MM-DD (default: today UTC).
 *   --sports=a,b    Restrict to these sports (default: all five).
 *
 * Idempotent: points are upserted by (sport, date), so re-running a day
 * overwrites that day rather than appending a duplicate.
 *
 * Exit codes:
 *   0  completed (at least one sport produced points)
 *   1  bad flags / no COSMOS_CONNECTION_STRING / no sport computed
 */

const path = require("path");
const fs = require("fs");

async function main() {
  const args = process.argv.slice(2);
  const backfill = args.includes("--backfill");
  const asOf = flag(args, "--as-of");
  const sportsArg = flag(args, "--sports");

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error(`--as-of must be YYYY-MM-DD, got "${asOf}"`);
    process.exit(1);
  }

  const distRoot = path.resolve(__dirname, "..", "dist");
  if (!fs.existsSync(path.join(distRoot, "services"))) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }
  const { runMarketIndexJob } = require(
    path.join(distRoot, "services", "insights", "marketIndexCompute.service.js"),
  );

  const sports = sportsArg ? sportsArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  console.log(JSON.stringify({
    event: "market_index_job_start",
    mode: backfill ? "backfill-180d" : "daily-append",
    asOf: asOf ?? "today",
    sports: sports ?? "all",
  }));

  const started = Date.now();
  const results = await runMarketIndexJob({ backfill, asOf, sports });

  // Reconciled summary — one line per sport plus a total, so a workflow
  // log shows at a glance whether every sport actually moved.
  for (const r of results) {
    console.log(JSON.stringify({
      event: "market_index_sport",
      sport: r.sport,
      epoch: r.epoch,
      basketSize: r.basketSize,
      pointsWritten: r.pointsWritten,
      pointsWithheld: r.pointsWithheld,
      firstDate: r.firstDate,
      lastDate: r.lastDate,
      latestLevel: r.latestLevel,
      latestUsedWeight: r.latestUsedWeight,
      reusedBasket: r.reusedBasket === true,
    }));
  }
  const totalPoints = results.reduce((s, r) => s + r.pointsWritten, 0);
  console.log(JSON.stringify({
    event: "market_index_job_done",
    sportsRequested: (sports ?? ["baseball", "basketball", "football", "hockey", "pokemon"]).length,
    sportsComputed: results.length,
    totalPointsWritten: totalPoints,
    totalPointsWithheld: results.reduce((s, r) => s + (r.pointsWithheld || 0), 0),
    elapsedSec: Math.round((Date.now() - started) / 1000),
  }));

  if (results.length === 0 || totalPoints === 0) {
    console.error("no index points written — check pool coverage for the window");
    process.exit(1);
  }
}

function flag(args, name) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
