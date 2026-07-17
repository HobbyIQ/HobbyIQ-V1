#!/usr/bin/env node
/**
 * CF-ATTRIBUTION-PHASE-1-DHASH (Drew, 2026-07-16). Standalone entry
 * point for the dHash pipeline. Runs from
 * .github/workflows/ch-sale-phashes.yml (daily 06:00 UTC + workflow_dispatch
 * for backfill).
 *
 * Flags:
 *   --days-back=N     How many days of ch_daily_sales to read (default 1).
 *   --sale-limit=N    Cap total sales processed (smoke test).
 *   --batch=N         Cosmos upsert batch size (default 500).
 *   --concurrency=N   Concurrent image downloads (default 32).
 *   --threshold=N     Hamming distance threshold for clustering (default 10).
 *   --force           Ignore existing phash rows and re-hash everything.
 */

const path = require("path");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "src", "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }

  const { runPhashPipeline } = require(
    path.join(distRoot, "src", "services", "attribution", "phashOrchestrator.service.js"),
  );

  const result = await runPhashPipeline({
    daysBack: args.daysBack ?? 1,
    saleLimit: args.saleLimit ?? null,
    batchSize: args.batch,
    downloadConcurrency: args.concurrency,
    hammingThreshold: args.threshold,
    skipAlreadyHashed: !args.force,
  });

  console.log(JSON.stringify({ event: "phash_final_result", ...result }));

  // Non-fatal on partial failure. Only exit 1 when the pipeline made
  // literally no progress (bad config).
  if (result.salesHashed === 0 && result.cardsClustered === 0 && result.salesConsidered > 0) {
    console.error("no hashes computed AND no cards clustered — exiting 1");
    process.exit(1);
  }
  process.exit(0);
}

function parseArgs(argv) {
  const out = { force: false };
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a.startsWith("--days-back=")) out.daysBack = Number(a.slice(12));
    else if (a.startsWith("--sale-limit=")) out.saleLimit = Number(a.slice(13));
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice(8));
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.slice(14));
    else if (a.startsWith("--threshold=")) out.threshold = Number(a.slice(12));
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
  console.error(JSON.stringify({
    event: "phash_fatal",
    error: (err && err.message) || String(err),
    stack: (err && err.stack) || null,
  }));
  process.exit(1);
});
