// CF-MLB-TOP-PLAYERS (Drew, 2026-07-13, PR #434): loads the stable MLB
// stars + top-prospects universe from backend/data/mlb-top-players.json.
// Fourth universe layer in dailyListingsSnapshotJob, ranking below all
// three others (user holdings, priority list, CH movers).
//
// Why: user holdings + priority + CH movers cover conviction and
// current activity — but they miss the STABLE stars whose cards drive
// heavy ambient volume even in quiet weeks. Judge might not be a top
// mover today, but Judge card supply/demand matters every day. This
// layer pins that baseline.
//
// Best-effort — missing/invalid file returns an empty list. Never
// throws. Cached 5 minutes in-process.

import fs from "node:fs";
import path from "node:path";

interface MlbTopPlayersFile {
  version: string;
  stars: string[];
  prospects: string[];
}

let _cache: MlbTopPlayersFile | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function candidatePaths(): string[] {
  return [
    path.join(__dirname, "..", "..", "..", "data", "mlb-top-players.json"),
    path.join(process.cwd(), "dist", "data", "mlb-top-players.json"),
    path.join(process.cwd(), "backend", "dist", "data", "mlb-top-players.json"),
    path.join(process.cwd(), "backend", "data", "mlb-top-players.json"),
    path.join(process.cwd(), "data", "mlb-top-players.json"),
  ];
}

function loadFileSync(explicitPath?: string): MlbTopPlayersFile | null {
  const paths = explicitPath ? [explicitPath] : candidatePaths();
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as MlbTopPlayersFile;
      if (!Array.isArray(parsed.stars) || !Array.isArray(parsed.prospects)) {
        console.warn(JSON.stringify({
          event: "mlb_top_players_invalid_shape",
          source: "mlbTopPlayers.service",
          path: p,
        }));
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "mlb_top_players_load_failed",
        source: "mlbTopPlayers.service",
        path: p,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }
  return null;
}

/**
 * Return the union of top MLB stars + top prospects (deduped, trimmed).
 * Empty on load failure — never throws.
 */
export async function loadMlbTopPlayers(opts: { path?: string } = {}): Promise<string[]> {
  const now = Date.now();
  const useCache = !opts.path;
  let loaded: MlbTopPlayersFile | null;
  if (useCache && _cache && now - _cacheLoadedAt < CACHE_TTL_MS) {
    loaded = _cache;
  } else {
    loaded = loadFileSync(opts.path);
    if (useCache) {
      _cache = loaded;
      _cacheLoadedAt = now;
    }
  }
  if (!loaded) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...loaded.stars, ...loaded.prospects]) {
    const trimmed = String(p ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function _resetMlbTopPlayersCacheForTests(): void {
  _cache = null;
  _cacheLoadedAt = 0;
}
