#!/usr/bin/env node
/**
 * CF-PLAYER-TREND (Drew, 2026-07-17). Nightly batch: for each of the
 * top-N players by 30d volume in ch_daily_sales, compute matched-cohort
 * momentum + velocity via playerTrendCompute and upsert to the
 * player_trends container.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/compute-player-trends.cjs
 *
 * Flags:
 *   --top-n=N          Number of top players by volume to compute (default 500)
 *   --window=N         Recent-window days (default 30)
 *   --prior=N          Prior-window days (default 30)
 *   --concurrency=N    In-flight player queries (default 8)
 *   --min-volume=N     Skip players with fewer than N sales in the
 *                      combined window (default 10)
 *
 * Exit codes:
 *   0  completed (playersComputed >= 1)
 *   1  bad flags / no COSMOS_CONNECTION_STRING / total failure
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
  const { computePlayerTrend } = require(
    path.join(distRoot, "services", "portfolioiq", "playerTrendCompute.service.js"),
  );
  const { upsertPlayerTrend } = require(
    path.join(distRoot, "services", "portfolioiq", "playerTrendStore.service.js"),
  );

  const topN = args.topN ?? 500;
  const recentWindowDays = args.window ?? 30;
  const priorWindowDays = args.prior ?? 30;
  const concurrency = args.concurrency ?? 8;
  const minVolume = args.minVolume ?? 10;

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const c = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");

  const t0 = Date.now();
  console.log(JSON.stringify({
    event: "player_trends_start", topN, recentWindowDays, priorWindowDays, concurrency, minVolume,
  }));

  // Step 1: get top-N players by combined-window volume.
  const combinedDays = recentWindowDays + priorWindowDays;
  const cutoffIso = new Date(Date.now() - combinedDays * 24 * 60 * 60 * 1000).toISOString();

  const groupRows = await queryPaged(c,
    `SELECT c.player, COUNT(1) AS n FROM c
     WHERE IS_STRING(c.player) AND c.sale_date >= @cutoff
     GROUP BY c.player`,
    [{ name: "@cutoff", value: cutoffIso }],
  );
  const topPlayers = groupRows
    .filter((r) => r.player && r.n >= minVolume)
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0))
    .slice(0, topN);

  console.log(JSON.stringify({
    event: "player_trends_top_players_ready",
    distinctPlayersCandidate: groupRows.length,
    selected: topPlayers.length,
    minVolume,
  }));

  // Step 2: for each player, in parallel-capped, query sales + compute + upsert.
  let done = 0;
  let failed = 0;
  const results = [];

  async function processOne(row) {
    const player = row.player;
    try {
      const sales = await queryPaged(c,
        `SELECT c.card_id, c.sale_date, c.price, c.year, c.card_set, c.variant, c.number
         FROM c WHERE c.player = @p AND c.sale_date >= @cutoff`,
        [
          { name: "@p", value: player },
          { name: "@cutoff", value: cutoffIso },
        ],
      );
      const filtered = sales
        .filter((r) => Number(r.price) > 0)
        .map((r) => ({
          cardId: r.card_id,
          saleDate: r.sale_date,
          price: Number(r.price),
          skuLabel: `${r.year ?? ""} ${r.card_set ?? ""} · ${r.variant ?? ""} · ${r.number ?? ""}`.trim(),
        }));
      const trend = computePlayerTrend(player, filtered, {
        recentWindowDays, priorWindowDays,
      });
      await upsertPlayerTrend(trend);
      done++;
      if (done % 25 === 0) {
        console.log(JSON.stringify({
          event: "player_trends_progress",
          done, failed, total: topPlayers.length,
          elapsedMs: Date.now() - t0,
        }));
      }
      results.push({ player, momentum: trend.momentum, direction: trend.direction });
    } catch (err) {
      failed++;
      console.log(JSON.stringify({
        event: "player_trends_player_error",
        player,
        error: err.message ?? String(err),
      }));
    }
  }

  // Simple concurrency pool.
  let idx = 0;
  async function worker() {
    while (idx < topPlayers.length) {
      const my = idx++;
      await processOne(topPlayers[my]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, topPlayers.length) }, () => worker()));

  const upDirections = results.filter((r) => r.direction === "up").length;
  const downDirections = results.filter((r) => r.direction === "down").length;

  console.log(JSON.stringify({
    event: "player_trends_complete",
    playersRequested: topPlayers.length,
    playersComputed: done,
    playersFailed: failed,
    directionCounts: {
      up: upDirections,
      down: downDirections,
      flat: results.length - upDirections - downDirections,
    },
    elapsedMs: Date.now() - t0,
  }));

  if (done === 0) {
    console.error("no players computed — exiting 1");
    process.exit(1);
  }
  process.exit(0);
}

async function queryPaged(container, sql, params) {
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
    if (a.startsWith("--top-n=")) out.topN = Number(a.slice(8));
    else if (a.startsWith("--window=")) out.window = Number(a.slice(9));
    else if (a.startsWith("--prior=")) out.prior = Number(a.slice(8));
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.slice(14));
    else if (a.startsWith("--min-volume=")) out.minVolume = Number(a.slice(13));
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
  console.error(JSON.stringify({ event: "player_trends_fatal", error: err.message ?? String(err) }));
  process.exit(1);
});
