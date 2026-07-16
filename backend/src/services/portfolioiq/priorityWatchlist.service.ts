// CF-PRIORITY-WATCHLIST (Drew, 2026-07-13, PR #435): loads the hand-
// curated priority-watchlist JSON and exposes a stable list of players
// the daily snapshot cron must always cover, regardless of whether any
// user has holdings on that player.
//
// Why: without this, the "own dataset" universe is only whatever users
// happen to hold. Backtest and discovery signals need broader coverage.
// The priority list is Drew's curated seed (~68 players sourced from the
// 2026-07-13 SharePoint sheet) and is unioned with the user-derived
// player set by dailyListingsSnapshotJob.
//
// Read is best-effort — missing/invalid file returns an empty list and
// logs a warning. Never throws (the snapshot job must always run).

import fs from "node:fs";
import path from "node:path";

interface PriorityWatchlistFile {
  version: string;
  players: string[];
  cards: Array<Record<string, unknown>>;
}

let _cache: PriorityWatchlistFile | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function candidatePaths(): string[] {
  // Mirrors bowmanParallelsDataset resolution: compiled __dirname lives
  // at .../dist/services/portfolioiq/ in prod and .../src/services/... at
  // dev. Cover both plus common cwd-anchored deploy layouts.
  return [
    path.join(__dirname, "..", "..", "..", "data", "priority-watchlist.json"),
    path.join(process.cwd(), "dist", "data", "priority-watchlist.json"),
    path.join(process.cwd(), "backend", "dist", "data", "priority-watchlist.json"),
    path.join(process.cwd(), "backend", "data", "priority-watchlist.json"),
    path.join(process.cwd(), "data", "priority-watchlist.json"),
  ];
}

function loadFileSync(explicitPath?: string): PriorityWatchlistFile | null {
  const paths = explicitPath ? [explicitPath] : candidatePaths();
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as PriorityWatchlistFile;
      if (!Array.isArray(parsed.players)) {
        console.warn(JSON.stringify({
          event: "priority_watchlist_invalid_shape",
          source: "priorityWatchlist.service",
          path: p,
        }));
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "priority_watchlist_load_failed",
        source: "priorityWatchlist.service",
        path: p,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }
  return null;
}

/**
 * Return the deduped, trimmed set of player display names on the
 * priority watchlist. Empty array on load failure — never throws.
 */
export async function loadPriorityPlayers(opts: { path?: string } = {}): Promise<string[]> {
  const now = Date.now();
  const useCache = !opts.path;
  if (!useCache || !_cache || now - _cacheLoadedAt > CACHE_TTL_MS) {
    const loaded = loadFileSync(opts.path);
    if (useCache) {
      _cache = loaded;
      _cacheLoadedAt = now;
    } else {
      // Explicit-path callers (tests) don't touch the module cache.
      return dedupePlayers(loaded?.players ?? []);
    }
  }
  return dedupePlayers(_cache?.players ?? []);
}

function dedupePlayers(input: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of input) {
    const trimmed = String(p ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function _resetPriorityWatchlistCacheForTests(): void {
  _cache = null;
  _cacheLoadedAt = 0;
}
