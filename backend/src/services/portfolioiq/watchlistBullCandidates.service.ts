// CF-WATCHLIST-BULL-CANDIDATES (Drew, 2026-07-13, PR #429): surface
// watchlisted players whose supply signal is bullish (listings trending
// down = rare, or supply_tight = rare + stable) so users see a "buy
// candidates" list without leaving the app.
//
// Uses the same listings trend the daily cron populates. When there
// aren't enough snapshots to fit a slope (< 2 days), the player is
// omitted rather than listed as "unavailable" — bull candidates should
// only show cards we're actually confident about.

import { getWatchlistEntries } from "../dailyiq/watchlistStore.service.js";
import { computeListingsTrend } from "../compiq/supplyDemandSignal.service.js";

type BullVerdict = "strong_bull" | "bull" | "supply_tight";

interface BullCandidate {
  playerId: string;
  playerName: string;
  teamName?: string;
  league?: "MLB" | "MiLB";
  verdict: BullVerdict;
  listingsDirection: "down" | "static";
  listingsSlopePerMonthPct: number;
  snapshotCount: number;
}

export interface WatchlistBullCandidatesResult {
  userId: string;
  totalWatchlisted: number;
  totalWithData: number;
  candidates: BullCandidate[];
  computedAt: string;
}

/**
 * Read the user's watchlist + compute a listings-only verdict per
 * player. Emit only bullish rows (down-slope listings = supply drying up,
 * or static in a healthy market = supply_tight). Sort by absolute slope
 * so the strongest signals surface first.
 *
 * Sales-side direction is NOT available for watchlisted players — they
 * aren't in the portfolio, so no persisted movementDirection. The
 * verdict here is thus listings-only and conservative. When we later
 * wire cross-user sales-momentum signals, the fold can richen.
 */
export async function buildWatchlistBullCandidates(
  userId: string,
): Promise<WatchlistBullCandidatesResult> {
  const entries = await getWatchlistEntries(userId).catch(() => []);
  const computedAt = new Date().toISOString();
  const candidates: BullCandidate[] = [];
  let withData = 0;

  for (const e of entries) {
    const name = e.playerName;
    if (!name) continue;
    const trend = await computeListingsTrend(name, 30).catch(() => null);
    if (!trend) continue;
    withData++;

    // Bullish supply reads only.
    let verdict: BullVerdict | null = null;
    let listingsDirection: "down" | "static" | null = null;
    if (trend.direction === "down") {
      // Supply drying up — pure bull-side supply signal.
      verdict = trend.slopePerMonthPct < -10 ? "strong_bull" : "bull";
      listingsDirection = "down";
    } else if (trend.direction === "static" && trend.slopePerMonthPct <= 0) {
      // Flat supply with slightly negative slope = supply_tight (nothing
      // available for buyers). Excludes upward-drifting static reads.
      verdict = "supply_tight";
      listingsDirection = "static";
    }
    if (!verdict || !listingsDirection) continue;

    candidates.push({
      playerId: e.playerId,
      playerName: name,
      teamName: e.teamName,
      league: e.league,
      verdict,
      listingsDirection,
      listingsSlopePerMonthPct: trend.slopePerMonthPct,
      snapshotCount: trend.n,
    });
  }

  candidates.sort((a, b) =>
    Math.abs(b.listingsSlopePerMonthPct) - Math.abs(a.listingsSlopePerMonthPct),
  );

  return {
    userId,
    totalWatchlisted: entries.length,
    totalWithData: withData,
    candidates,
    computedAt,
  };
}
