/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * Background job that pre-computes matched-cohort momentum for
 * portfolio-owned players and writes to Redis cache.
 *
 * Runtime `getPlayerTrendSnapshot` reads from that cache and prefers
 * the pre-computed matched-cohort over the raw sales-stats-by-player
 * signal.
 *
 * Design notes:
 * - Interval is 24h. Matched-cohort momentum is a slow-moving player-
 *   level signal; nightly refresh matches the analytical value + keeps
 *   CH call volume bounded.
 * - Cost per cycle: ~N_players × ~30 CH prices-by-card calls (with
 *   internal fanout capped by fetchCardHedgeMatchedCohort's concurrency
 *   knob). For 5k players × 30 cards = 150k calls. Sequential per-player
 *   pacing prevents CH rate-limit backoff.
 * - Env-gated: MATCHED_COHORT_JOB_ENABLED === "true" starts the job.
 *   Default off — flip on after review + deploy. Rollback = env=false.
 */

import { fetchCardHedgeMatchedCohort } from "../services/playerTrend/cardHedgeMatchedCohortProvider.js";
import { writeMatchedCohortToCache } from "../services/playerTrend/matchedCohortCache.js";
import {
  listAllPortfolioUserIds,
  readUserDoc,
} from "../services/portfolioiq/portfolioStore.service.js";
import {
  getSalesStatsByPlayer,
  getTotalSalesByPlayer,
} from "../services/compiq/cardhedge.client.js";
import { computeMomentumFromNormalizedWeeks } from "../services/playerTrend/momentum.compute.js";
import type { NormalizedWeeklySales } from "../services/playerTrend/playerTrend.types.js";
import {
  assembleMarketPlayersPayload,
  writeMarketPlayersPayload,
  type MarketPlayersJobInput,
} from "../services/dailyiq/marketPlayers.service.js";

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000; // 5min after boot
const DEFAULT_MAX_PLAYERS_PER_CYCLE = 500;
const DEFAULT_PER_PLAYER_DELAY_MS = 250; // rate-limit smoothing
const PROVIDER_NAME = "cardhedge";

let _running = false;
let _firstRunTimer: NodeJS.Timeout | null = null;
let _intervalTimer: NodeJS.Timeout | null = null;

function isEnabled(): boolean {
  const flag = String(process.env.MATCHED_COHORT_JOB_ENABLED ?? "").toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

function readIntervalMs(): number {
  const hours = Number(process.env.MATCHED_COHORT_JOB_INTERVAL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_INTERVAL_HOURS) * 3600 * 1000;
}

function readMaxPlayers(): number {
  const n = Number(process.env.MATCHED_COHORT_JOB_MAX_PLAYERS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PLAYERS_PER_CYCLE;
}

/**
 * Scan all portfolio holdings and return the unique set of player names.
 * Trims + case-normalizes for deduplication.
 */
async function collectUniquePortfolioPlayers(): Promise<string[]> {
  const seen = new Map<string, string>(); // normalized → original display form
  let userIds: string[] = [];
  try {
    userIds = await listAllPortfolioUserIds();
  } catch (err) {
    console.warn(
      `[matched-cohort] listAllPortfolioUserIds failed: ${(err as Error)?.message ?? err}`,
    );
    return [];
  }
  for (const userId of userIds) {
    try {
      const doc = await readUserDoc(userId);
      const holdings = doc.holdings ?? {};
      for (const holdingId in holdings) {
        const h = holdings[holdingId];
        const name = h?.playerName;
        if (typeof name !== "string") continue;
        const trimmed = name.trim();
        if (trimmed.length === 0) continue;
        const key = trimmed.toLowerCase();
        if (!seen.has(key)) seen.set(key, trimmed);
      }
    } catch (err) {
      console.warn(
        `[matched-cohort] readUserDoc(${userId}) failed (non-fatal): ${(err as Error)?.message ?? err}`,
      );
    }
  }
  return Array.from(seen.values());
}

async function runCycle(): Promise<void> {
  const start = Date.now();
  const playersAll = await collectUniquePortfolioPlayers();
  const maxPlayers = readMaxPlayers();
  const players = playersAll.slice(0, maxPlayers);
  console.log(
    JSON.stringify({
      event: "matched_cohort_cycle_start",
      source: "matched-cohort-job",
      playersDiscovered: playersAll.length,
      playersProcessing: players.length,
      cap: maxPlayers,
    }),
  );

  let succeeded = 0;
  let failed = 0;
  let cohortSizes = 0;
  // CF-MATCHED-COHORT-FAILURE-VISIBILITY (2026-07-02): the null-return case
  // (fetchCardHedgeMatchedCohort resolves to null, without throwing) was
  // being counted toward `failed` but not logged with the player name. That
  // hid ~17% of daily traffic in an opaque bucket — 13/74 in the observed
  // cycle. Emit a structured event per null-return so KQL can slice by
  // player name and drive the next tranche of CH catalog escalations or
  // sales-stats fixes.
  const nullPlayers: string[] = [];
  // Accumulators for the DailyIQ market-players precompute — populated
  // alongside the per-player cache writes so we don't re-scan CH later.
  const perPlayerCohorts: MarketPlayersJobInput["perPlayerCohorts"] = [];
  for (const player of players) {
    try {
      const result = await fetchCardHedgeMatchedCohort(player);
      if (result) {
        await writeMatchedCohortToCache(player, result, PROVIDER_NAME);
        succeeded += 1;
        cohortSizes += result.cohort.length;
        if (result.medianRatio !== null) {
          perPlayerCohorts.push({
            player,
            cohort: {
              medianRatio: result.medianRatio,
              meanRatio: result.meanRatio ?? result.medianRatio,
              cohortSize: result.cohort.length,
              latestWeekActiveCards: result.latestWeekActiveCards,
              latestWeekStart: result.latestWeekStart,
              priorWindowWeeksCount: result.priorWindowWeeksCount,
              computedAtMs: Date.now(),
            },
          });
        }
      } else {
        failed += 1;
        nullPlayers.push(player);
      }
    } catch (err) {
      failed += 1;
      console.warn(
        `[matched-cohort] player=${player} failed: ${(err as Error)?.message ?? err}`,
      );
    }
    if (DEFAULT_PER_PLAYER_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, DEFAULT_PER_PLAYER_DELAY_MS));
    }
  }
  if (nullPlayers.length > 0) {
    // Single structured event with the full list — KQL can `mv-expand`
    // for per-player slicing. Cheaper than N per-player events for a
    // list that's expected to be O(20) in steady state.
    console.log(
      JSON.stringify({
        event: "matched_cohort_null_returns",
        source: "matched-cohort-job",
        count: nullPlayers.length,
        players: nullPlayers,
      }),
    );
  }

  // ── DailyIQ market-players precompute ───────────────────────────
  // For every player that produced a cohort, ALSO grab their raw
  // volume ratio + 30d total-sales so the assembled payload can
  // classify supply_dry and rank by volume. Batched into a single
  // getTotalSalesByPlayer call and per-player weekly stats.
  const cohortPlayerNames = perPlayerCohorts.map((r) => r.player);
  const perPlayerTotal30d: MarketPlayersJobInput["perPlayerTotal30d"] = [];
  const perPlayerVolumeRatio: MarketPlayersJobInput["perPlayerVolumeRatio"] = [];
  try {
    const totals = cohortPlayerNames.length > 0
      ? await getTotalSalesByPlayer(cohortPlayerNames)
      : null;
    for (const r of totals?.results ?? []) {
      perPlayerTotal30d.push({ player: r.player, totalSales30d: r.total_sales });
    }
  } catch (err) {
    console.warn(
      `[matched-cohort] getTotalSalesByPlayer batch failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
  }
  // Volume ratio requires the per-player weekly stats; done one-by-one
  // since the endpoint returns per-player already, and this data is
  // already cached from earlier /search calls in most cases.
  for (const player of cohortPlayerNames) {
    try {
      const stats = await getSalesStatsByPlayer([player], "week");
      const pr = stats?.results?.find((r) => r.player === player);
      if (!pr) continue;
      const buckets: NormalizedWeeklySales[] = (pr.buckets ?? [])
        .filter((b) => !b.partial)
        .map((b) => ({
          weekStart: b.start,
          weekEnd: b.end,
          count: Number.isFinite(b.count) ? b.count : 0,
          totalDollars: Number.isFinite(b.total_amount) ? b.total_amount : 0,
          avgSale: Number.isFinite(b.average_sale) ? b.average_sale : 0,
        }));
      const momentum = computeMomentumFromNormalizedWeeks(buckets);
      perPlayerVolumeRatio.push({ player, volumeRatio: momentum.volumeRatio });
    } catch (err) {
      // absorb; player is skipped from supply_dry classification only
    }
  }

  try {
    const payload = assembleMarketPlayersPayload({
      perPlayerCohorts,
      perPlayerTotal30d,
      perPlayerVolumeRatio,
    });
    await writeMarketPlayersPayload(payload);
    console.log(
      JSON.stringify({
        event: "market_players_payload_written",
        source: "matched-cohort-job",
        trending: payload.trending.length,
        fading: payload.fading.length,
        topVolume30d: payload.topVolume30d.length,
        supplyDryLeadingUp: payload.supplyDryLeadingUp.length,
      }),
    );
  } catch (err) {
    console.warn(
      `[matched-cohort] market-players precompute failed (non-fatal): ${(err as Error)?.message ?? err}`,
    );
  }

  console.log(
    JSON.stringify({
      event: "matched_cohort_cycle_end",
      source: "matched-cohort-job",
      elapsedMs: Date.now() - start,
      succeeded,
      failed,
      avgCohortSize: succeeded > 0 ? Math.round((cohortSizes / succeeded) * 10) / 10 : 0,
    }),
  );
}

/**
 * Start the matched-cohort periodic job. Idempotent — re-calling is a
 * no-op when already running. Returns without scheduling when the env
 * gate is off.
 */
export function startMatchedCohortJob(): void {
  if (_running) return;
  if (!isEnabled()) {
    console.log(
      "[matched-cohort] not started — MATCHED_COHORT_JOB_ENABLED not set to true",
    );
    return;
  }
  _running = true;
  const intervalMs = readIntervalMs();
  console.log(
    `[matched-cohort] starting — interval ${intervalMs / 3600000}h, first run in ${DEFAULT_FIRST_DELAY_MS / 60000}min`,
  );
  _firstRunTimer = setTimeout(async () => {
    try {
      await runCycle();
    } catch (e: unknown) {
      console.warn(
        `[matched-cohort] first cycle failed: ${(e as Error)?.message ?? e}`,
      );
    }
    _intervalTimer = setInterval(async () => {
      try {
        await runCycle();
      } catch (e: unknown) {
        console.warn(
          `[matched-cohort] cycle failed: ${(e as Error)?.message ?? e}`,
        );
      }
    }, intervalMs);
  }, DEFAULT_FIRST_DELAY_MS);
}

/** Stop the job. Used by tests + clean shutdown. */
export function stopMatchedCohortJob(): void {
  if (_firstRunTimer) {
    clearTimeout(_firstRunTimer);
    _firstRunTimer = null;
  }
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
  _running = false;
}

/** Test-only: reset in-memory state. */
export function _resetMatchedCohortJobForTests(): void {
  stopMatchedCohortJob();
}
