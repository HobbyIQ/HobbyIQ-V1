// CF-CH-TOP-MOVERS-UNIVERSE (Drew, 2026-07-13, PR #433): pulls unique
// player names from CardHedge's /cards/top-movers endpoint so the daily
// listings snapshot cron covers "whatever the market is moving right
// now" — not just user holdings and Drew's hand-curated priority list.
//
// Why this matters: user holdings define the personal scorecard, the
// priority list covers Drew's convictions, but neither captures ambient
// market activity (a rookie call-up, a playoff surge, a Bowman release
// week). CH's top-movers is the freshest read on that activity — the
// top-N gainers by trend across the entire catalog. Extracting their
// players gives us discovery-side coverage with zero manual curation.
//
// Best-effort — errors return an empty list so the snapshot job still
// runs. Cached 6h in-memory (CH itself caches 1h server-side + 6h in
// our cacheWrap layer, but that's per-request; this service adds
// per-process caching so multiple job runs in the same window don't
// stampede CH).

import { getTopMovers } from "../compiq/cardhedge.client.js";

const CACHE_TTL_MS = 6 * 3600 * 1000;
const DEFAULT_CARD_COUNT = 100;

let _cachedPlayers: string[] | null = null;
let _cachedAt = 0;

interface LoadOpts {
  cardCount?: number;
  category?: string;
  forceRefresh?: boolean;
}

/**
 * Return the deduped set of player display names from CH's top movers.
 * Empty array on CH failure or missing API key.
 */
export async function loadTopMoverPlayers(opts: LoadOpts = {}): Promise<string[]> {
  const now = Date.now();
  if (!opts.forceRefresh && _cachedPlayers && now - _cachedAt < CACHE_TTL_MS) {
    return _cachedPlayers;
  }

  const cardCount = opts.cardCount ?? DEFAULT_CARD_COUNT;
  const category = opts.category ?? "Baseball";
  try {
    const movers = await getTopMovers({ count: cardCount, category });
    if (!movers || !Array.isArray(movers)) {
      _cachedPlayers = [];
      _cachedAt = now;
      return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of movers) {
      const raw = String(m?.player ?? "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
    _cachedPlayers = out;
    _cachedAt = now;
    return out;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ch_top_mover_players_load_failed",
      source: "chTopMoverPlayers.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

export function _resetTopMoverPlayersCacheForTests(): void {
  _cachedPlayers = null;
  _cachedAt = 0;
}
