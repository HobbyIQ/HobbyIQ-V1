/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * Cache read/write helpers for pre-computed matched-cohort results.
 *
 * Background job (see PR follow-up) populates the cache overnight for
 * a rolling list of players. Runtime `getPlayerTrendSnapshot` reads
 * from the cache and prefers the pre-computed matched-cohort when
 * available, falling back to the raw sales-stats-by-player signal
 * from PR #229.
 *
 * Cache key format:
 *   matched-cohort:v1:<normalized_player>
 *
 * Normalization: lowercase + collapse whitespace + trim. Same shape as
 * the CH `player` filter uses, so cache hits align with what the fetch
 * layer produces.
 */

import { cacheGet, cacheSet, cacheDel } from "../shared/cache.service.js";
import type { MatchedCohortResult } from "./matchedCohort.types.js";

const KEY_PREFIX = "matched-cohort:v1:";
const DEFAULT_TTL_SEC = 24 * 3600; // 24h
const STALE_TOLERANCE_SEC = 48 * 3600; // 48h — cache read allowed to serve stale up to 2x TTL

function normalizePlayer(playerName: string): string {
  return playerName.toLowerCase().replace(/\s+/g, " ").trim();
}

function cacheKey(playerName: string): string {
  return KEY_PREFIX + normalizePlayer(playerName);
}

export interface CachedMatchedCohort {
  result: MatchedCohortResult;
  /** Unix ms when the result was captured — for freshness reporting downstream. */
  computedAtMs: number;
  /** Provider name at compute time — for post-hoc migration accounting. */
  providerName: string;
}

/**
 * Read the pre-computed matched-cohort result for a player.
 * Returns null when no cache entry OR when the entry is beyond the
 * stale tolerance window. Never throws — cache errors return null.
 */
export async function readMatchedCohortFromCache(
  playerName: string,
): Promise<CachedMatchedCohort | null> {
  if (!playerName) return null;
  try {
    const raw = await cacheGet(cacheKey(playerName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedMatchedCohort;
    if (!parsed?.result || !parsed?.computedAtMs) return null;
    const ageSec = (Date.now() - parsed.computedAtMs) / 1000;
    if (ageSec > STALE_TOLERANCE_SEC) return null;
    return parsed;
  } catch (err) {
    console.warn(
      `[matchedCohortCache] read failed for player=${playerName}: ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Write a computed matched-cohort result to cache.
 * Uses DEFAULT_TTL_SEC unless overridden. Never throws.
 */
export async function writeMatchedCohortToCache(
  playerName: string,
  result: MatchedCohortResult,
  providerName: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<void> {
  if (!playerName) return;
  const payload: CachedMatchedCohort = {
    result,
    computedAtMs: Date.now(),
    providerName,
  };
  try {
    await cacheSet(cacheKey(playerName), JSON.stringify(payload), ttlSec);
  } catch (err) {
    console.warn(
      `[matchedCohortCache] write failed for player=${playerName}: ${(err as Error)?.message ?? err}`,
    );
  }
}

/** Delete a player's cached entry — for admin / rollback operations. */
export async function invalidateMatchedCohort(playerName: string): Promise<void> {
  if (!playerName) return;
  try {
    await cacheDel(cacheKey(playerName));
  } catch (err) {
    console.warn(
      `[matchedCohortCache] invalidate failed for player=${playerName}: ${(err as Error)?.message ?? err}`,
    );
  }
}
