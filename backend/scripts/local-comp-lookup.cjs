#!/usr/bin/env node
/**
 * CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). CLI to run a localCompStore
 * lookup end-to-end against the ch_daily_sales corpus. Emits the full
 * result as JSON — the shape the router will consume in Phase 2.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/local-comp-lookup.cjs --card-id=<CH_card_id>
 *   node backend/scripts/local-comp-lookup.cjs --year=2026 --set="2026 Bowman Baseball" \
 *                                              --variant="Base" --number="CPA-EHA" \
 *                                              --grade="Raw" --grader="Raw"
 *
 * Flags:
 *   --card-id=STR      Single-partition lookup by CH card_id
 *   --year=N
 *   --set=STR
 *   --variant=STR
 *   --number=STR
 *   --grade=STR
 *   --grader=STR
 *   --all-grades       Ignore grade/grader/variant filters (for premium curves)
 *   --window=N         Trend window days (default 90)
 *   --recent=N         Recent sales cap (default 20)
 *   --skip-premiums    Skip grader/parallel premium math
 */

const path = require("path");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const { lookupLocalComps } = require(
    path.join(distRoot, "services", "portfolioiq", "localCompStore.service.js"),
  );

  const key = {
    cardId: args.cardId,
    year: args.year !== undefined ? Number(args.year) : undefined,
    cardSet: args.set,
    variant: args.variant,
    number: args.number,
    grade: args.grade,
    grader: args.grader,
    allGrades: !!args.allGrades,
  };

  const result = await lookupLocalComps(key, {
    trendWindowDays: args.window ? Number(args.window) : undefined,
    recentSalesLimit: args.recent ? Number(args.recent) : undefined,
    skipPremiums: !!args.skipPremiums,
  });

  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === "--all-grades") out.allGrades = true;
    else if (a === "--skip-premiums") out.skipPremiums = true;
    else if (a.startsWith("--card-id=")) out.cardId = a.slice(10);
    else if (a.startsWith("--year=")) out.year = a.slice(7);
    else if (a.startsWith("--set=")) out.set = a.slice(6);
    else if (a.startsWith("--variant=")) out.variant = a.slice(10);
    else if (a.startsWith("--number=")) out.number = a.slice(9);
    else if (a.startsWith("--grade=")) out.grade = a.slice(8);
    else if (a.startsWith("--grader=")) out.grader = a.slice(9);
    else if (a.startsWith("--window=")) out.window = a.slice(9);
    else if (a.startsWith("--recent=")) out.recent = a.slice(9);
  }
  return out;
}

async function pathExists(p) {
  try {
    const fs = require("fs/promises");
    await fs.access(p);
    return true;
  } catch { return false; }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "fatal", error: err.message ?? String(err) }));
  process.exit(1);
});
