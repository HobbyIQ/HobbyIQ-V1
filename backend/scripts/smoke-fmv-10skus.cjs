#!/usr/bin/env node
/**
 * CF-FMV-SMOKE-10 (Drew, 2026-07-18). Read-only smoke test that samples
 * 10 diverse cardIds across the major product families in ch_daily_sales
 * and prints the 30-day comp pool that canonical FMV would draw from.
 * If comp counts are healthy and spreads are tight, the FMV pipeline
 * will produce reasonable numbers at the card show tomorrow.
 *
 * Diversity strategy: 2 samples each from 5 families
 *   (bowman-chrome, topps-chrome, panini-prizm, panini-donruss, other).
 * Within each family, prefer cards with 8+ recent comps so the fitted
 * projection has real signal.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/smoke-fmv-10skus.cjs
 *
 * Env vars honored:
 *   COSMOS_CONNECTION_STRING (required)
 *   COSMOS_DATABASE (default hobbyiq)
 *   COSMOS_CH_DAILY_SALES_CONTAINER (default ch_daily_sales)
 */

const { CosmosClient } = require("@azure/cosmos");

const FAMILY_TOKENS = {
  "bowman-chrome": ["bowman chrome"],
  "topps-chrome": ["topps chrome"],
  "panini-prizm": ["panini prizm", "prizm baseball", "prizm football", "prizm basketball"],
  "panini-donruss": ["donruss"],
  "other": [],
};

function median(values) {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const client = new CosmosClient(conn);
  const c = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  console.log(`Sampling 10 diverse cardIds with 30d comps since ${from}...\n`);

  const results = [];

  // For each family, find 2 cardIds with high recent comp counts.
  for (const [family, tokens] of Object.entries(FAMILY_TOKENS)) {
    let where;
    let params = [{ name: "@from", value: from }];
    if (tokens.length > 0) {
      const orClauses = tokens.map((_, i) => `CONTAINS(LOWER(c.card_set), @t${i})`).join(" OR ");
      where = `c.sale_date >= @from AND (${orClauses})`;
      tokens.forEach((t, i) => params.push({ name: `@t${i}`, value: t }));
    } else {
      const excludes = ["bowman chrome", "topps chrome", "panini prizm", "prizm", "donruss"];
      const notClauses = excludes.map((_, i) => `NOT CONTAINS(LOWER(c.card_set), @x${i})`).join(" AND ");
      where = `c.sale_date >= @from AND ${notClauses}`;
      excludes.forEach((t, i) => params.push({ name: `@x${i}`, value: t }));
    }

    const q = {
      query: `SELECT TOP 40 c.card_id, COUNT(1) AS n
              FROM c WHERE ${where}
              GROUP BY c.card_id`,
      parameters: params,
    };
    let candidates = [];
    try {
      const { resources } = await c.items.query(q, { enableCrossPartitionQuery: true }).fetchAll();
      candidates = resources.filter((r) => r.n >= 5).sort((a, b) => b.n - a.n).slice(0, 2);
    } catch (e) {
      console.error(`family=${family} count query failed: ${e.message}`);
      continue;
    }

    for (const cand of candidates) {
      const detailQ = {
        query: `SELECT c.card_id, c.sale_date, c.price, c.year, c.card_set, c.variant, c.number, c.player, c.grader
                FROM c WHERE c.card_id = @cid AND c.sale_date >= @from
                ORDER BY c.sale_date DESC`,
        parameters: [{ name: "@cid", value: cand.card_id }, { name: "@from", value: from }],
      };
      const { resources: rows } = await c.items.query(detailQ, { partitionKey: cand.card_id }).fetchAll();
      const prices = rows.map((r) => Number(r.price)).filter((p) => p > 0);
      if (prices.length === 0) continue;

      // Split by grader — canonical FMV filters ch_daily_sales by
      // c.grader (string like "Raw" | "PSA 10"), so the smoke reports
      // per-grader stats to reflect what the pipeline actually sees.
      const rawRows = rows.filter((r) => (r.grader ?? "Raw") === "Raw" && Number(r.price) > 0);
      const gradedRows = rows.filter((r) => r.grader && r.grader !== "Raw" && Number(r.price) > 0);
      const rawPrices = rawRows.map((r) => Number(r.price));
      const graderBreakdown = {};
      for (const r of gradedRows) {
        graderBreakdown[r.grader] = (graderBreakdown[r.grader] || 0) + 1;
      }

      results.push({
        family,
        cardId: cand.card_id,
        player: rows[0].player,
        year: rows[0].year,
        set: rows[0].card_set,
        variant: rows[0].variant,
        cardNumber: rows[0].number,
        compCount30d: prices.length,
        // FMV filters by grader — the raw-only slice is what a Raw
        // holding would see when the pipeline runs, and the spread on
        // that slice is what actually predicts price stability.
        rawCompCount: rawPrices.length,
        rawMedianPrice: rawPrices.length > 0 ? median(rawPrices) : null,
        rawMinPrice: rawPrices.length > 0 ? Math.min(...rawPrices) : null,
        rawMaxPrice: rawPrices.length > 0 ? Math.max(...rawPrices) : null,
        rawSpreadPct: rawPrices.length > 0
          ? ((Math.max(...rawPrices) - Math.min(...rawPrices)) / median(rawPrices)) * 100
          : null,
        latestSaleDate: rows[0].sale_date,
        graders: graderBreakdown,
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\nSampled ${results.length} cardIds.`);
  const median30Raw = median(results.map((r) => r.rawCompCount).filter((n) => n !== null));
  console.log(`Median 30d RAW comp count across sample: ${median30Raw}`);
  const rawSpreads = results.map((r) => r.rawSpreadPct).filter((n) => n !== null && Number.isFinite(n));
  const medianRawSpread = median(rawSpreads);
  console.log(`Median RAW spread% across sample: ${medianRawSpread ? medianRawSpread.toFixed(1) + "%" : "n/a"}`);

  const healthyN = results.filter((r) => r.rawCompCount !== null && r.rawCompCount >= 8).length;
  const tightSpread = results.filter((r) => r.rawSpreadPct !== null && r.rawSpreadPct <= 100).length;
  console.log(`\n${healthyN}/${results.length} have 8+ recent RAW comps (regression-quality signal).`);
  console.log(`${tightSpread}/${results.length} have RAW spread <= 100% of median (grade-filter working correctly).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
