#!/usr/bin/env node
/**
 * CF-OBSERVED-MULTIPLIERS (Drew, 2026-07-17). Nightly batch: compute
 * per-family observed grader multipliers over the past N days of
 * ch_daily_sales and upsert to observed_grader_multipliers.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/compute-observed-multipliers.cjs [--window=90]
 *
 * Flags:
 *   --window=N     Days of history (default 90)
 *   --min-raw=N    Min raw n per family to publish (default 20)
 *   --min-graded=N Min graded n per (family,tier) to publish (default 5)
 */

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }
  const { computeObservedMultipliers } = require(
    path.join(distRoot, "services", "portfolioiq", "observedMultipliersCompute.service.js"),
  );
  const { upsertMultipliers } = require(
    path.join(distRoot, "services", "portfolioiq", "observedMultipliersStore.service.js"),
  );

  const windowDays = args.window ?? 90;
  const minRawSamples = args.minRaw ?? 20;
  const minGradedSamples = args.minGraded ?? 5;

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const c = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

  const t0 = Date.now();
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  console.log(JSON.stringify({
    event: "observed_multipliers_start",
    windowDays, minRawSamples, minGradedSamples,
  }));

  // Pull all sales in the window. This is a heavy cross-partition query
  // (~200k+ rows at current baseball scale); it's a nightly one-shot.
  const iter = c.items.query({
    query: `SELECT c.card_set_type, c.price, c.grader, c.grade, c.sale_date
            FROM c WHERE c.sale_date >= @cutoff`,
    parameters: [{ name: "@cutoff", value: cutoff }],
  }, { maxItemCount: 5000 });

  const sales = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) {
      for (const r of page.resources) {
        if (!r.card_set_type) continue;
        sales.push({
          cardSetType: r.card_set_type,
          price: Number(r.price),
          grader: r.grader ?? "",
          grade: r.grade ?? "",
          saleDate: r.sale_date,
        });
      }
    }
  }

  console.log(JSON.stringify({
    event: "observed_multipliers_sales_loaded",
    salesLoaded: sales.length,
    loadMs: Date.now() - t0,
  }));

  const result = computeObservedMultipliers(sales, {
    windowDays, minRawSamples, minGradedSamples,
  });

  const upserted = await upsertMultipliers(result.rows);

  console.log(JSON.stringify({
    event: "observed_multipliers_complete",
    familiesConsidered: result.familiesConsidered,
    familiesPublished: result.familiesPublished,
    rowsUpserted: upserted,
    elapsedMs: Date.now() - t0,
    topRows: result.rows.slice(0, 10).map((r) => ({
      family: r.familyLabel,
      tier: r.graderTier,
      multiplier: r.multiplier,
      confidence: r.confidence,
      n: `${r.nGraded}g/${r.nRaw}r`,
    })),
  }));

  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--window=")) out.window = Number(a.slice(9));
    else if (a.startsWith("--min-raw=")) out.minRaw = Number(a.slice(10));
    else if (a.startsWith("--min-graded=")) out.minGraded = Number(a.slice(13));
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
  console.error(JSON.stringify({ event: "observed_multipliers_fatal", error: err.message ?? String(err) }));
  process.exit(1);
});
