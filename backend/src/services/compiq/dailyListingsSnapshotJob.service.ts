// CF-SUPPLY-DEMAND-SIGNAL — daily cron (Drew, 2026-07-13, PR #421):
// walk the union of (all-users portfolio players ∪ all-users watchlist
// players), take the top-N by holding count, and snapshot each into
// listings_snapshots.
//
// Auth: uses a single designated user's eBay OAuth token
// (env `LISTINGS_SNAPSHOT_USER_ID`, defaults to admin-testing-hobbyiq).
// One user's token can serve every player query — Browse doesn't care
// which user account you're authenticated as.
//
// Rate: eBay Browse free tier is 5K calls/day. Default top-N=500 leaves
// 10x headroom for retries + manual snapshot use.

import { getPortfolioContainer } from "../portfolioiq/portfolioStore.service.js";
import { fetchPlayerListingsSummary } from "../ebay/ebayListingSearch.service.js";
import { upsertSnapshot } from "../portfolioiq/listingsSnapshotStore.service.js";

const DEFAULT_USER_ID = "admin-testing-hobbyiq";
const DEFAULT_TOP_N = 500;
const DEFAULT_CONCURRENCY = 3;

export interface SnapshotJobSummary {
  playersSeen: number;
  playersProcessed: number;
  snapshotsCreated: number;
  errors: number;
  elapsedMs: number;
  topPlayersSample: Array<{ player: string; holdingCount: number }>;
}

interface PlayerAgg {
  displayName: string;
  holdingCount: number;
}

/**
 * Read every portfolio doc via cross-partition query and aggregate
 * unique player names with holding counts. Watchlist support is queued
 * for a follow-up — watchlists are in a separate container, will fold
 * in once the snapshot cron proves stable.
 */
async function enumeratePlayers(): Promise<Map<string, PlayerAgg>> {
  const container = await getPortfolioContainer();
  if (!container) return new Map();

  const players = new Map<string, PlayerAgg>();
  const query = "SELECT c.holdings FROM c WHERE c.id LIKE 'user-%' OR c.id LIKE 'admin-%' OR c.id LIKE 'personal-%'";
  const it = container.items.query({ query }, {});
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const doc of resources as Array<{ holdings?: Record<string, any> }>) {
      const holdings = doc.holdings ?? {};
      for (const h of Object.values(holdings)) {
        const raw = String((h as any).playerName ?? (h as any).player ?? "").trim();
        if (!raw) continue;
        const key = raw.toLowerCase();
        const existing = players.get(key);
        if (existing) {
          existing.holdingCount++;
        } else {
          players.set(key, { displayName: raw, holdingCount: 1 });
        }
      }
    }
  }
  return players;
}

/**
 * Run the daily job: enumerate players, take top-N, snapshot each.
 * Returns a summary the caller can log or return to a request.
 */
export async function runDailyListingsSnapshotJob(opts: {
  userId?: string;
  topN?: number;
  concurrency?: number;
} = {}): Promise<SnapshotJobSummary> {
  const started = Date.now();
  const userId = opts.userId ?? process.env.LISTINGS_SNAPSHOT_USER_ID ?? DEFAULT_USER_ID;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const players = await enumeratePlayers();
  const ranked = Array.from(players.values())
    .sort((a, b) => b.holdingCount - a.holdingCount)
    .slice(0, topN);

  console.log(JSON.stringify({
    event: "daily_listings_snapshot_start",
    source: "dailyListingsSnapshotJob.service",
    userId,
    playersSeen: players.size,
    playersToProcess: ranked.length,
    topN,
    concurrency,
  }));

  let snapshotsCreated = 0;
  let errors = 0;

  // Concurrency-limited execution — one bounded pool.
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= ranked.length) return;
      const p = ranked[idx];
      try {
        const summary = await fetchPlayerListingsSummary(userId, p.displayName);
        if (!summary) {
          errors++;
          continue;
        }
        await upsertSnapshot({
          playerDisplay: p.displayName,
          totalListings: summary.totalListings,
          medianAsk: summary.medianAsk,
          pricedItemCount: summary.pricedItemCount,
          effectiveQuery: summary.effectiveQuery,
          snapshottedAt: summary.snapshottedAt,
        });
        snapshotsCreated++;
      } catch (err) {
        errors++;
        console.warn(JSON.stringify({
          event: "daily_listings_snapshot_item_error",
          source: "dailyListingsSnapshotJob.service",
          player: p.displayName,
          error: (err as Error)?.message ?? String(err),
        }));
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const summary: SnapshotJobSummary = {
    playersSeen: players.size,
    playersProcessed: ranked.length,
    snapshotsCreated,
    errors,
    elapsedMs: Date.now() - started,
    topPlayersSample: ranked.slice(0, 10).map((p) => ({
      player: p.displayName,
      holdingCount: p.holdingCount,
    })),
  };
  console.log(JSON.stringify({
    event: "daily_listings_snapshot_done",
    source: "dailyListingsSnapshotJob.service",
    ...summary,
  }));
  return summary;
}
