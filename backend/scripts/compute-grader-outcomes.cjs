#!/usr/bin/env node
/**
 * CF-GRADER-OUTCOMES (Drew, 2026-07-17). Nightly: compute observed
 * grader-outcome tier distributions per (family, grader) over the past
 * N days of ch_daily_sales. Upsert to grader_outcome_distributions.
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
  const { computeGraderOutcomes } = require(
    path.join(distRoot, "services", "portfolioiq", "graderOutcomeCompute.service.js"),
  );
  const { upsertOutcomes } = require(
    path.join(distRoot, "services", "portfolioiq", "graderOutcomeStore.service.js"),
  );

  const windowDays = args.window ?? 90;
  const minGradedSamples = args.minGraded ?? 20;

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const c = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

  const t0 = Date.now();
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  console.log(JSON.stringify({
    event: "grader_outcomes_start", windowDays, minGradedSamples,
  }));

  // Only graded rows — filter server-side to keep the payload small.
  const iter = c.items.query({
    query: `SELECT c.card_set_type, c.price, c.grader, c.grade, c.sale_date
            FROM c WHERE c.sale_date >= @cutoff
                     AND IS_STRING(c.grader) AND c.grader != "Raw" AND c.grader != ""`,
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
    event: "grader_outcomes_sales_loaded",
    salesLoaded: sales.length,
    loadMs: Date.now() - t0,
  }));

  const result = computeGraderOutcomes(sales, { windowDays, minGradedSamples });
  const upserted = await upsertOutcomes(result.rows);

  console.log(JSON.stringify({
    event: "grader_outcomes_complete",
    rowsPublished: result.rows.length,
    rowsUpserted: upserted,
    elapsedMs: Date.now() - t0,
    topRows: result.rows.slice(0, 5).map((r) => ({
      family: r.familyLabel,
      grader: r.grader,
      n: r.totalGradedSamples,
      conf: r.confidence,
      top_tier_share: Object.entries(r.tierShares).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([t, s]) => `${t}=${(s * 100).toFixed(0)}%`).join(", "),
    })),
  }));
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--window=")) out.window = Number(a.slice(9));
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
  console.error(JSON.stringify({ event: "grader_outcomes_fatal", error: err.message ?? String(err) }));
  process.exit(1);
});
