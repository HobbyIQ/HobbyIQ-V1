#!/usr/bin/env node
/**
 * CF-PHASE-6A-CANONICALIZATION (Drew, 2026-07-17). Probes ch_daily_sales
 * for cardinality of the free-text fields we're planning to normalize:
 * player, card_set, card_set_type, variant, grader, group.
 *
 * Output: JSON summary with:
 *   - Total rows
 *   - Unique counts per field
 *   - Top 20 values by frequency per field
 *   - Rough estimated LLM cost for canonicalization
 *
 * Run any time — once backfill has data, this gives us the numbers to
 * validate the design's cost/scale assumptions.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/probe-ch-corpus-cardinality.cjs
 *   [--field=player|card_set|variant|all]
 *   [--top=20]
 *
 * Exit codes:
 *   0  probe completed
 *   1  Cosmos unavailable / bad flags
 */

const { CosmosClient } = require("@azure/cosmos");

const FIELDS = ["player", "card_set", "card_set_type", "variant", "grader", "group"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cosmos = process.env.COSMOS_CONNECTION_STRING;
  if (!cosmos) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
  const containerId = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
  const targetFields = args.field === "all" || !args.field ? FIELDS : [args.field];
  const top = args.top ?? 20;

  const client = new CosmosClient(cosmos);
  const { database } = await client.databases.createIfNotExists({ id: dbName });
  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: ["/card_id"] },
  });

  // Total row count (cross-partition).
  const t0 = Date.now();
  const { resources: totalRes } = await container.items
    .query({ query: "SELECT VALUE COUNT(1) FROM c" })
    .fetchAll();
  const totalRows = totalRes[0] ?? 0;
  console.log(JSON.stringify({ event: "probe_row_count", totalRows, took_ms: Date.now() - t0 }));

  if (totalRows === 0) {
    console.log(JSON.stringify({
      event: "probe_empty",
      message: "ch_daily_sales is empty — has the backfill workflow completed?",
    }));
    process.exit(0);
  }

  const report = { totalRows, perField: {} };

  for (const field of targetFields) {
    const tField = Date.now();
    console.log(JSON.stringify({ event: "probe_field_start", field }));

    // Distinct count. Cross-partition — expensive on 7M rows but one-time.
    const { resources: distinctRes } = await container.items
      .query({
        query: `SELECT VALUE COUNT(1) FROM (SELECT DISTINCT VALUE c.${field} FROM c WHERE IS_STRING(c.${field}))`,
      })
      .fetchAll();
    const distinct = distinctRes[0] ?? 0;

    // Top-N by frequency.
    const { resources: topRes } = await container.items
      .query({
        query: `SELECT TOP ${top} c.${field} AS value, COUNT(1) AS n FROM c WHERE IS_STRING(c.${field}) GROUP BY c.${field} ORDER BY COUNT(1) DESC`,
      })
      .fetchAll();

    // Simple case-variance sample: for the top-10 values, look for
    // near-duplicates by lowercase equivalence — a rough dirty-data
    // indicator without spending LLM tokens.
    const nearDupes = detectCaseVariance(topRes);

    const fieldReport = {
      field,
      distinct_count: distinct,
      top_values: topRes.slice(0, top),
      near_duplicate_pairs_in_top_20: nearDupes,
      took_ms: Date.now() - tField,
    };
    report.perField[field] = fieldReport;
    console.log(JSON.stringify({ event: "probe_field_done", ...fieldReport }));
  }

  // Cost estimate for LLM canonicalization.
  // - Embeddings: ~3 tokens per string × distinct × $0.02/1M
  // - LLM adjudication: assume 5% of distincts are ambiguous, ~100 per
  //   batch, ~1300 tokens per batch, Haiku 4.5 pricing ($1/$5 per M).
  let embedCost = 0;
  let llmCost = 0;
  for (const field of ["player", "card_set", "variant"]) {
    if (!report.perField[field]) continue;
    const d = report.perField[field].distinct_count;
    embedCost += (d * 3) / 1_000_000 * 0.02;
    const batches = Math.ceil((d * 0.05) / 100);
    llmCost += batches * (500 / 1_000_000 * 1.00 + 800 / 1_000_000 * 5.00);
  }
  const summary = {
    event: "probe_summary",
    totalRows,
    fieldsProbed: targetFields,
    estimated_canonicalization_cost_usd: {
      embeddings: Math.round(embedCost * 10000) / 10000,
      llm_adjudication: Math.round(llmCost * 10000) / 10000,
      total: Math.round((embedCost + llmCost) * 10000) / 10000,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--field=")) out.field = a.slice(8);
    else if (a.startsWith("--top=")) out.top = Number(a.slice(6));
  }
  return out;
}

function detectCaseVariance(topValues) {
  const seen = new Map();
  const dupes = [];
  for (const row of topValues) {
    const v = String(row.value ?? "").trim();
    const k = v.toLowerCase();
    if (seen.has(k) && seen.get(k) !== v) {
      dupes.push({ variants: [seen.get(k), v] });
    } else {
      seen.set(k, v);
    }
  }
  return dupes;
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "probe_fatal",
    error: err.message ?? String(err),
  }));
  process.exit(1);
});
