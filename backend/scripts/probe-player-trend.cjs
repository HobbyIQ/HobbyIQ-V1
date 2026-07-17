#!/usr/bin/env node
/**
 * CF-PLAYER-TREND (Drew, 2026-07-17). Read-only CLI. Queries every
 * ch_daily_sales row for a given player, feeds through
 * computePlayerTrend, prints matched-cohort momentum + velocity +
 * top-20 per-card ratios.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/probe-player-trend.cjs --player="Eric Hartman"
 *   node backend/scripts/probe-player-trend.cjs --player="Shohei Ohtani"
 *   node backend/scripts/probe-player-trend.cjs --player="Aaron Judge" --top=10
 *
 * Flags:
 *   --player=STR       (required) Player name — exact match on c.player
 *   --window=N         Recent-window days (default 30)
 *   --prior=N          Prior-window days (default 30)
 *   --min=N            Min sales per window for cohort qualification (default 3)
 *   --top=N            Top-N cards in result (default 20)
 */

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.player) { console.error("usage: --player=\"Eric Hartman\""); process.exit(1); }
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
  const { computePlayerTrend } = require(
    path.join(distRoot, "services", "portfolioiq", "playerTrendCompute.service.js"),
  );

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const c = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

  const t0 = Date.now();
  const rows = await query(c,
    `SELECT c.card_id, c.sale_date, c.price, c.year, c.card_set, c.variant, c.number
     FROM c WHERE c.player = @p`,
    [{ name: "@p", value: args.player }],
  );

  const sales = rows
    .filter((r) => Number(r.price) > 0)
    .map((r) => ({
      cardId: r.card_id,
      saleDate: r.sale_date,
      price: Number(r.price),
      skuLabel: `${r.year} ${r.card_set} · ${r.variant} · ${r.number}`,
    }));

  const opts = {
    recentWindowDays: args.window ? Number(args.window) : undefined,
    priorWindowDays: args.prior ? Number(args.prior) : undefined,
    minSalesPerWindow: args.min ? Number(args.min) : undefined,
    topCardsInResult: args.top ? Number(args.top) : undefined,
  };
  Object.keys(opts).forEach((k) => opts[k] === undefined && delete opts[k]);

  const result = computePlayerTrend(args.player, sales, opts);

  console.log(JSON.stringify({
    player: result.player,
    computedAt: result.computedAt,
    query_ms: Date.now() - t0,
    corpus_rows: rows.length,
    trend: {
      momentum: result.momentum,
      direction: result.direction,
      velocity_per_week: result.velocityPerWeek,
      cards_in_pool: result.cardsInPool,
      qualifying_cards: result.qualifyingCards,
      total_sales_windowed: result.totalSales,
      flags: result.flags,
    },
    top_per_card_ratios: result.perCardRatios,
    options: result.options,
  }, null, 2));
}

async function query(container, sql, params) {
  const iter = container.items.query({ query: sql, parameters: params }, { maxItemCount: 1000 });
  const out = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) out.push(...page.resources);
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith("--player=")) out.player = a.slice(9);
    else if (a.startsWith("--window=")) out.window = a.slice(9);
    else if (a.startsWith("--prior=")) out.prior = a.slice(8);
    else if (a.startsWith("--min=")) out.min = a.slice(6);
    else if (a.startsWith("--top=")) out.top = a.slice(6);
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
