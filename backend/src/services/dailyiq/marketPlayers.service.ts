/**
 * CF-DAILYIQ-MARKET-PLAYERS (2026-07-01):
 * Precomputed lists of market-facing player signals for the DailyIQ
 * dashboard. Populated by the matched-cohort background job after it
 * finishes its per-player cache writes. Read cheaply by the /api/dailyiq
 * market endpoint (single Redis GET) so the DailyIQ card never blocks
 * on CH.
 *
 * Three lists surfaced:
 *   trending           — top-N players by matched-cohort medianRatio (up)
 *   fading             — top-N players by matched-cohort medianRatio (down)
 *   topVolume30d       — top-N players by 30d total-sales count
 *   supplyDryLeadingUp — supply_dry quadrant (vol↓ + price↑) leading indicator
 */

import { cacheGet, cacheSet } from "../shared/cache.service.js";
import type { PlayerMatchedCohortSummary } from "../playerTrend/playerTrend.types.js";

const CACHE_KEY = "dailyiq:market-players:v1";
const CACHE_TTL_SEC = 26 * 3600; // 26h — slightly longer than the job's 24h cadence

export interface TrendingPlayerRow {
  player: string;
  medianRatio: number;
  cohortSize: number;
  latestWeekActiveCards: number;
  latestWeekStart: string;
  computedAtMs: number;
}

export interface VolumeRankRow {
  player: string;
  totalSales30d: number;
}

export interface SupplyDryRow {
  player: string;
  medianRatio: number;
  volumeRatio: number | null;
  cohortSize: number;
  latestWeekActiveCards: number;
}

export interface MarketPlayersPayload {
  generatedAt: string;
  trending: TrendingPlayerRow[];
  fading: TrendingPlayerRow[];
  topVolume30d: VolumeRankRow[];
  supplyDryLeadingUp: SupplyDryRow[];
  /**
   * CF-DAILYIQ-BOWMAN-2YR (2026-07-02): Bowman-scoped top-20 volume list.
   * Ranks players who appear in the 2025-2026 Bowman universe (2025 Bowman
   * Chrome, 2025 Bowman Draft Chrome, 2026 Bowman) by their 30d total
   * sales. Volume signal covers the full player universe from CH, so this
   * list is populated regardless of matched-cohort coverage.
   */
  bowman2yrTopVolume30d: VolumeRankRow[];
  /**
   * CF-DAILYIQ-BOWMAN-2YR (2026-07-02): Bowman-scoped top-20 momentum list.
   * Ranks players who appear in BOTH the Bowman universe AND have a valid
   * matched-cohort (via portfolio scan) by medianRatio DESC. Trending-up
   * only (>= 1.05); non-trending players omitted from the list. Rows are
   * a superset shape of TrendingPlayerRow so the iOS renderer can reuse
   * the existing cell.
   */
  bowman2yrTopMomentum: TrendingPlayerRow[];
}

/**
 * Snapshot of all inputs the job feeds in. Grouped so the assembly
 * logic is pure + easily testable.
 */
export interface MarketPlayersJobInput {
  /** Per-player matched-cohort summary (from the matched-cohort cache). */
  perPlayerCohorts: Array<{
    player: string;
    cohort: PlayerMatchedCohortSummary;
  }>;
  /** Per-player 30d total sales count (from CH total-sales-by-player). */
  perPlayerTotal30d: Array<{
    player: string;
    totalSales30d: number;
  }>;
  /** Per-player raw volume ratio (from PR #229 momentum signal). */
  perPlayerVolumeRatio: Array<{
    player: string;
    volumeRatio: number | null;
  }>;
  /**
   * CF-DAILYIQ-BOWMAN-2YR (2026-07-02): unique player set discovered from
   * CH's 2025-2026 Bowman catalog (Bowman Chrome + Bowman Draft Chrome).
   * Used to scope the bowman2yr* lists. Empty array → those lists are
   * emitted empty (defensive; the job may fail to discover on a CH blip).
   * Player names in this set are compared case-insensitively.
   */
  bowmanUniverse?: string[];
  /** How many rows per list. Default 20. */
  topN?: number;
}

const DEFAULT_TOP_N = 20;
/** Minimum cohort size for trending eligibility — filters out one-card noise. */
const MIN_COHORT_FOR_TRENDING = 3;
/** Minimum meaningful deviation from 1.0 for trending/fading inclusion. */
const MIN_TREND_DELTA = 0.05;
/** Above this ratio a player is "trending up" enough to surface. */
const TREND_UP_FLOOR = 1.05;
/** Below this ratio a player is "fading" enough to surface. */
const TREND_DOWN_CEIL = 0.95;

/**
 * Pure assembly. Callers hand in the raw per-player inputs; this
 * function sorts, filters, and slices into the four output lists.
 */
export function assembleMarketPlayersPayload(
  input: MarketPlayersJobInput,
): MarketPlayersPayload {
  const topN = input.topN ?? DEFAULT_TOP_N;

  const volumeRatioByPlayer = new Map(
    input.perPlayerVolumeRatio.map((r) => [r.player.toLowerCase(), r.volumeRatio]),
  );

  const trendingRowsAll: TrendingPlayerRow[] = input.perPlayerCohorts
    .filter((r) => r.cohort.cohortSize >= MIN_COHORT_FOR_TRENDING)
    .filter((r) => Math.abs(r.cohort.medianRatio - 1) >= MIN_TREND_DELTA)
    .map((r) => ({
      player: r.player,
      medianRatio: r.cohort.medianRatio,
      cohortSize: r.cohort.cohortSize,
      latestWeekActiveCards: r.cohort.latestWeekActiveCards,
      latestWeekStart: r.cohort.latestWeekStart,
      computedAtMs: r.cohort.computedAtMs,
    }));

  const trending = trendingRowsAll
    .filter((r) => r.medianRatio >= TREND_UP_FLOOR)
    .sort((a, b) => b.medianRatio - a.medianRatio)
    .slice(0, topN);

  const fading = trendingRowsAll
    .filter((r) => r.medianRatio <= TREND_DOWN_CEIL)
    .sort((a, b) => a.medianRatio - b.medianRatio)
    .slice(0, topN);

  const topVolume30d = input.perPlayerTotal30d
    .filter((r) => r.totalSales30d > 0)
    .sort((a, b) => b.totalSales30d - a.totalSales30d)
    .slice(0, topN);

  const supplyDryLeadingUp = input.perPlayerCohorts
    .filter((r) => r.cohort.cohortSize >= MIN_COHORT_FOR_TRENDING)
    .map((r) => ({
      player: r.player,
      medianRatio: r.cohort.medianRatio,
      volumeRatio: volumeRatioByPlayer.get(r.player.toLowerCase()) ?? null,
      cohortSize: r.cohort.cohortSize,
      latestWeekActiveCards: r.cohort.latestWeekActiveCards,
    }))
    // supply_dry = matched-cohort UP AND volume DOWN (both meaningful)
    .filter((r) => r.medianRatio >= TREND_UP_FLOOR)
    .filter((r) => r.volumeRatio !== null && r.volumeRatio <= 0.95)
    .sort((a, b) => b.medianRatio - a.medianRatio)
    .slice(0, topN);

  // ── CF-DAILYIQ-BOWMAN-2YR (2026-07-02) ────────────────────────────────
  // Bowman-scoped lists are derived from the same per-player inputs, but
  // filtered by membership in the discovered Bowman universe. When
  // bowmanUniverse is missing or empty, both lists emit as empty arrays —
  // the payload shape stays stable so iOS can render "no data" cleanly.
  const bowmanSet = new Set(
    (input.bowmanUniverse ?? []).map((p) => p.toLowerCase()),
  );

  const bowman2yrTopVolume30d = bowmanSet.size === 0
    ? []
    : input.perPlayerTotal30d
        .filter((r) => r.totalSales30d > 0)
        .filter((r) => bowmanSet.has(r.player.toLowerCase()))
        .sort((a, b) => b.totalSales30d - a.totalSales30d)
        .slice(0, topN);

  const bowman2yrTopMomentum = bowmanSet.size === 0
    ? []
    : trendingRowsAll
        .filter((r) => bowmanSet.has(r.player.toLowerCase()))
        .filter((r) => r.medianRatio >= TREND_UP_FLOOR)
        .sort((a, b) => b.medianRatio - a.medianRatio)
        .slice(0, topN);

  return {
    generatedAt: new Date().toISOString(),
    trending,
    fading,
    topVolume30d,
    supplyDryLeadingUp,
    bowman2yrTopVolume30d,
    bowman2yrTopMomentum,
  };
}

/** Write the assembled payload to Redis. Never throws. */
export async function writeMarketPlayersPayload(
  payload: MarketPlayersPayload,
): Promise<void> {
  try {
    await cacheSet(CACHE_KEY, JSON.stringify(payload), CACHE_TTL_SEC);
  } catch (err) {
    console.warn(
      `[marketPlayers] write failed: ${(err as Error)?.message ?? err}`,
    );
  }
}

/** Read the latest payload. Returns null when cache empty. */
export async function readMarketPlayersPayload(): Promise<MarketPlayersPayload | null> {
  try {
    const raw = await cacheGet(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MarketPlayersPayload;
  } catch (err) {
    console.warn(
      `[marketPlayers] read failed: ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}
