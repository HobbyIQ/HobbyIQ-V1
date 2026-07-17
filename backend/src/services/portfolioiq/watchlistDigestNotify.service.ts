// CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). Orchestration layer for
// the watchlist-digest push. Iterates every opted-in user, loads their
// watchlist rows + per-player trends, computes the digest, and
// dispatches ONE push per user (only when moverCount >= 1).
//
// This module owns policy (per-user consolidation, best-effort semantics)
// but NOT the compute (pure math is in watchlistDigestCompute.service.ts)
// or the APNs wire (in notification.service.ts).

import { listUsersWithWatchlistOptIn } from "./portfolioStore.service.js";
import { getWatchlistEntries } from "../dailyiq/watchlistStore.service.js";
import { readPlayerTrend } from "./playerTrendStore.service.js";
import { sendWatchlistDigestNotification } from "../notification.service.js";
import {
  computeWatchlistDigest,
  type WatchlistDigestInputRow,
  type WatchlistDigestResult,
} from "./watchlistDigestCompute.service.js";

export interface WatchlistDigestNotifyResult {
  usersScanned: number;
  usersWithMovers: number;
  sent: number;
  failed: number;
}

/**
 * Given the list of opted-in users (each carrying { userId, apnsDeviceToken }),
 * fan out the watchlist digest push. Individual failures are logged and
 * the batch continues. Never throws.
 */
export async function sendWatchlistDigestsForOptedInUsers(): Promise<WatchlistDigestNotifyResult> {
  let usersScanned = 0;
  let usersWithMovers = 0;
  let sent = 0;
  let failed = 0;

  let users: Array<{ userId: string; apnsDeviceToken: string | null }> = [];
  try {
    users = await listUsersWithWatchlistOptIn();
  } catch (err: any) {
    console.error(
      `[watchlistDigestNotify] listUsersWithWatchlistOptIn failed: ${err?.message ?? err}`,
    );
    return { usersScanned: 0, usersWithMovers: 0, sent: 0, failed: 0 };
  }

  for (const user of users) {
    usersScanned += 1;
    let digest: WatchlistDigestResult;
    try {
      digest = await computeUserDigest(user.userId);
    } catch (err: any) {
      failed += 1;
      console.error(
        `[watchlistDigestNotify] compute failed user=${user.userId}: ${err?.message ?? err}`,
      );
      continue;
    }

    if (!digest.push || digest.moverCount === 0) continue;
    usersWithMovers += 1;

    try {
      const r = await sendWatchlistDigestNotification(user.userId, digest.push);
      sent += r.sent;
      failed += r.failed;
    } catch (err: any) {
      failed += 1;
      console.error(
        `[watchlistDigestNotify] send failed user=${user.userId}: ${err?.message ?? err}`,
      );
    }
  }

  return { usersScanned, usersWithMovers, sent, failed };
}

/**
 * Load a single user's watchlist rows + attach the stored PlayerTrend
 * snapshot for each. Exported for direct test coverage of the row-
 * hydration layer without needing to stub the full orchestration path.
 */
export async function computeUserDigest(userId: string): Promise<WatchlistDigestResult> {
  const entries = await getWatchlistEntries(userId);
  const rows: WatchlistDigestInputRow[] = [];
  for (const entry of entries) {
    const playerName = String(entry.playerName ?? "").trim();
    if (!playerName) continue;
    let trend = null;
    try {
      const stored = await readPlayerTrend(playerName);
      if (stored) {
        trend = {
          momentum: stored.momentum,
          direction: stored.direction,
          qualifyingCards: stored.qualifyingCards,
        };
      }
    } catch (err: any) {
      // best-effort — a Cosmos hiccup on one player shouldn't zero the
      // whole digest. The row falls through with trend=null and is
      // silently skipped by the compute layer.
      console.error(
        `[watchlistDigestNotify] readPlayerTrend failed player=${playerName}: ${err?.message ?? err}`,
      );
    }
    rows.push({
      playerId: entry.playerId,
      playerName,
      trend,
    });
  }
  return computeWatchlistDigest(rows);
}
