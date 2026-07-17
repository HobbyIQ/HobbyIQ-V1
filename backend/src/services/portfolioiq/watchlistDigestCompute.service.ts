// CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). Pure math for the
// daily watchlist-digest push. Given a set of "watchlist rows" each
// carrying the player's current stored PlayerTrend snapshot, detect
// which rows are movers (up or down) worth surfacing to the user.
//
// v1 mover rule (simplification): a row is a mover when
//   direction !== "flat" AND |momentum - 1| > 0.10
// i.e. the current player-trend snapshot shows > 10% movement in EITHER
// direction and the direction band is not "flat". v2 will consume a
// day-over-day PlayerTrend snapshot delta instead of the point-in-time
// momentum ratio.
//
// No IO here — takes numbers, returns a digest. Testable in isolation.

/** Mover-detection threshold (fraction). 0.10 == 10%. Pinned by test. */
export const _MOVER_THRESHOLD = 0.10;

/** Bare inputs the digest needs — one entry per watchlist row. */
export interface WatchlistDigestInputRow {
  playerId: string;
  playerName: string;
  /** Current stored PlayerTrend for the player, or null if none. */
  trend: {
    momentum: number;
    direction: "up" | "flat" | "down";
    qualifyingCards: number;
  } | null;
}

/** A single mover surfaced by the digest. */
export interface WatchlistDigestMover {
  playerId: string;
  playerName: string;
  /** Fractional percent movement — 0.32 means +32%. Signed by direction. */
  momentumDelta: number;
  direction: "up" | "down";
}

/** Full digest result. `push` is null when the digest has zero movers
 *  (caller should NOT dispatch a push). `movers` is sorted by
 *  |momentumDelta| DESC so the top mover is first. */
export interface WatchlistDigestResult {
  totalWatched: number;
  moverCount: number;
  movers: WatchlistDigestMover[];
  push: {
    moverCount: number;
    topMoverName: string;
    topMoverPercent: number;
    topMoverDirection: "up" | "down";
  } | null;
}

/**
 * Given a user's watchlist rows (with per-player trend snapshots
 * already attached), emit the digest. Callers are expected to have
 * loaded the trend rows from playerTrendStore first — this function
 * doesn't touch IO.
 *
 * Rules:
 *   - A row with `trend === null` is silently skipped (no trend yet;
 *     can happen for players outside the nightly compute universe).
 *   - direction === "flat" is never a mover regardless of momentum.
 *   - Threshold is |momentum - 1| > 0.10.
 *   - The push preview picks the mover with the biggest absolute delta.
 *     Ties broken by name ascending for deterministic output.
 */
export function computeWatchlistDigest(
  rows: WatchlistDigestInputRow[],
): WatchlistDigestResult {
  const movers: WatchlistDigestMover[] = [];
  for (const row of rows) {
    if (!row.trend) continue;
    if (row.trend.direction === "flat") continue;
    if (!Number.isFinite(row.trend.momentum)) continue;
    const delta = row.trend.momentum - 1;
    if (Math.abs(delta) <= _MOVER_THRESHOLD) continue;
    // direction from the trend engine is authoritative — but coerce to
    // the digest's up/down bicolor (we've already filtered "flat").
    const digestDirection: "up" | "down" =
      row.trend.direction === "up" ? "up" : "down";
    movers.push({
      playerId: row.playerId,
      playerName: row.playerName,
      momentumDelta: delta,
      direction: digestDirection,
    });
  }

  movers.sort((a, b) => {
    const diff = Math.abs(b.momentumDelta) - Math.abs(a.momentumDelta);
    if (diff !== 0) return diff;
    return a.playerName.localeCompare(b.playerName);
  });

  if (movers.length === 0) {
    return {
      totalWatched: rows.length,
      moverCount: 0,
      movers: [],
      push: null,
    };
  }

  const top = movers[0];
  return {
    totalWatched: rows.length,
    moverCount: movers.length,
    movers,
    push: {
      moverCount: movers.length,
      topMoverName: top.playerName,
      topMoverPercent: top.momentumDelta * 100,
      topMoverDirection: top.direction,
    },
  };
}
