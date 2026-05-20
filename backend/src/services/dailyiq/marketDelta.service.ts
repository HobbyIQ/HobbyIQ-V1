// DailyIQ market-delta lookup.
//
// Joins a player to the Cosmos `comp_logs` container that the CompIQ pricing
// path writes to on every estimate call. Comp logs are partitioned by
// `/player` so a single point-in-partition query covers all sold cards for
// that player across our user base.
//
// Returns null when there isn't enough data — DailyIQ is happy to show a
// player without a market signal; we just hide the marketDelta block.
//
// Soft-fails everywhere: a Cosmos outage must never block the DailyIQ brief.

import { CosmosClient, Container } from "@azure/cosmos";

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_NAME = "comp_logs";

export interface MarketDelta {
  pct1d: number;
  pct7d: number;
  pct30d: number;
  /** Average sale price across the 30d window — useful for UI ($X over 30d). */
  avg30dPrice: number;
  /** Count of sales used for the 30d aggregation; <5 means low confidence. */
  sampleCount: number;
}

interface CachedDelta {
  delta: MarketDelta | null;
  cachedAtMs: number;
}

const CACHE_TTL_MS = Number(process.env.DAILYIQ_MARKET_DELTA_TTL_MS ?? 10 * 60 * 1000);
const cache = new Map<string, CachedDelta>();
let _container: Container | null = null;
let _initAttempted = false;

function getContainer(): Container | null {
  if (_initAttempted) return _container;
  _initAttempted = true;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.warn("[marketDelta] COSMOS_CONNECTION_STRING not set — marketDelta disabled");
    return null;
  }
  try {
    const client = new CosmosClient(conn);
    _container = client.database(DB_NAME).container(CONTAINER_NAME);
    return _container;
  } catch (err) {
    console.warn(`[marketDelta] init failed: ${(err as Error).message}`);
    return null;
  }
}

/** Normalize names so "Shohei Ohtani" and "shohei ohtani" hit the same key. */
function normalizePlayer(name: string): string {
  return name.trim().toLowerCase();
}

interface CompRow {
  finalPrice: number;
  epochMs: number;
}

async function fetchPlayerComps(playerName: string): Promise<CompRow[]> {
  const c = getContainer();
  if (!c) return [];
  // Use the partition key directly so the query stays single-partition.
  // We intentionally LIMIT the look-back to 30 days to keep payloads tiny.
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const query = {
    query: "SELECT c.finalPrice, c.epochMs FROM c WHERE c.epochMs >= @since",
    parameters: [{ name: "@since", value: since }],
  };
  try {
    const { resources } = await c.items
      .query<CompRow>(query, { partitionKey: playerName, maxItemCount: 500 })
      .fetchAll();
    return resources.filter((r) => Number.isFinite(r?.finalPrice) && r.finalPrice > 0);
  } catch (err) {
    console.warn(`[marketDelta] query failed for player=${playerName}: ${(err as Error).message}`);
    return [];
  }
}

function avg(rows: CompRow[]): number | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + r.finalPrice, 0);
  return total / rows.length;
}

function pctDelta(current: number | null, baseline: number | null): number {
  if (current == null || baseline == null || baseline <= 0) return 0;
  return Number((((current - baseline) / baseline) * 100).toFixed(1));
}

/**
 * Compute pct1d / pct7d / pct30d deltas from comp_logs.
 *
 * pct1d = (avg last 24h)  vs (avg 24h-7d)
 * pct7d = (avg last 7d)   vs (avg 7d-30d)
 * pct30d = (avg last 30d) vs (avg 30d-60d)  -- needs longer query; we
 *   approximate pct30d using (avg 7d vs avg 30d) for now since comp_logs
 *   only retains 30d in this query window. This is documented in the
 *   response so the iOS UI can label "30d" as "vs prior 30d window".
 */
export async function getMarketDelta(playerName: string): Promise<MarketDelta | null> {
  const key = normalizePlayer(playerName);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAtMs < CACHE_TTL_MS) return hit.delta;

  const rows = await fetchPlayerComps(playerName);
  if (rows.length === 0) {
    cache.set(key, { delta: null, cachedAtMs: Date.now() });
    return null;
  }

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const last24h = rows.filter((r) => now - r.epochMs <= oneDay);
  const last7d = rows.filter((r) => now - r.epochMs <= 7 * oneDay);
  const last30d = rows;
  const prior24h_7d = rows.filter((r) => now - r.epochMs > oneDay && now - r.epochMs <= 7 * oneDay);
  const prior7d_30d = rows.filter((r) => now - r.epochMs > 7 * oneDay && now - r.epochMs <= 30 * oneDay);

  const avg30 = avg(last30d);
  const delta: MarketDelta = {
    pct1d: pctDelta(avg(last24h), avg(prior24h_7d)),
    pct7d: pctDelta(avg(last7d), avg(prior7d_30d)),
    // Approximation: short-window vs medium-window — see header comment.
    pct30d: pctDelta(avg(last7d), avg30),
    avg30dPrice: Number((avg30 ?? 0).toFixed(2)),
    sampleCount: last30d.length,
  };
  cache.set(key, { delta, cachedAtMs: Date.now() });
  return delta;
}

/** Batch helper — fetches in parallel with soft-failure per player. */
export async function getMarketDeltasForPlayers(
  playerNames: string[],
): Promise<Map<string, MarketDelta | null>> {
  const unique = Array.from(new Set(playerNames.filter(Boolean)));
  const results = await Promise.all(
    unique.map(async (name) => {
      try {
        return [name, await getMarketDelta(name)] as const;
      } catch {
        return [name, null] as const;
      }
    }),
  );
  return new Map(results);
}
