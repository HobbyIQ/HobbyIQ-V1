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
  for (const player of players) {
    try {
      const result = await fetchCardHedgeMatchedCohort(player);
      if (result) {
        await writeMatchedCohortToCache(player, result, PROVIDER_NAME);
        succeeded += 1;
        cohortSizes += result.cohort.length;
      } else {
        failed += 1;
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
