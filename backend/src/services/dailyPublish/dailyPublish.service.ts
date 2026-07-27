// CF-DAILY-PUBLISH (Drew, 2026-07-27). Twice-daily editorial snapshot
// for Market + Insights. Publishes at 5AM ET and 5PM ET via GH Actions;
// web pages read the cached snapshot for instant loads with an "As of"
// timestamp instead of hitting the live compute path per request.
//
// Snapshot contents (all globally scoped — no user context needed):
//   - Top gainers + losers by 7-day market delta pct
//   - Notable recent sales (≥$500 in the last 30 days)
//
// Cached in Cosmos container `daily_snapshots`, partition `/type`.
// One doc per snapshot type (currently only "market") — publish
// upserts by id so the read path always returns the latest.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { MarketDelta } from "../dailyiq/marketDelta.service.js";
import { getMarketDeltasForPlayers } from "../dailyiq/marketDelta.service.js";
import { getLatestBrief } from "../../repositories/dailyiq.repository.js";
import { readNotableSales } from "../portfolioiq/notableSalesRead.service.js";
import type { NotableSale } from "../portfolioiq/notableSalesRead.service.js";

export interface MarketMoverSnapshot {
  playerName: string;
  delta: MarketDelta;
  confidence: "high" | "low" | "none";
}

export interface MarketSnapshotDoc {
  id: "market";
  type: "market";
  docType: "daily_snapshot";
  publishedAt: string;
  publishedSlot: "morning" | "evening";
  window: { selected: "7d"; pct30dLabel: "30d %" };
  topGainers: MarketMoverSnapshot[];
  topLosers: MarketMoverSnapshot[];
  poolSize: number;
  notableSales: NotableSale[];
}

// ─── Cosmos plumbing ─────────────────────────────────────────────

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_ID = process.env.COSMOS_DAILY_SNAPSHOTS_CONTAINER ?? "daily_snapshots";

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      if (!endpoint && !connStr) {
        console.warn("[dailyPublish] no Cosmos config — no-op mode");
        return null;
      }
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_ID,
        partitionKey: { paths: ["/type"] },
      });
      _container = container;
      return container;
    } catch (err) {
      console.error("[dailyPublish] container init failed:", err);
      return null;
    } finally {
      _initPromise = null;
    }
  })();
  return _initPromise;
}

// ─── Compute ─────────────────────────────────────────────────────

function deriveConfidence(delta: MarketDelta | null): "high" | "low" | "none" {
  if (!delta) return "none";
  return delta.sampleCount >= 5 ? "high" : "low";
}

/**
 * Compute the market snapshot payload — top movers + notable sales.
 * Pulls the DailyIQ candidate pool (mlb + milb) and ranks by |7d %|.
 * Returns null when the DailyIQ brief is empty (nothing to snapshot).
 */
export async function computeMarketSnapshot(opts: {
  slot: "morning" | "evening";
  limitPerSide?: number;
}): Promise<MarketSnapshotDoc | null> {
  const limitPerSide = opts.limitPerSide ?? 20;

  // Player pool from the latest DailyIQ brief (already in Cosmos cache;
  // no live vendor calls here).
  const brief = await getLatestBrief();
  const pool: string[] = brief
    ? [
        ...(brief.mlb ?? []).map((p) => p.playerName),
        ...(brief.milb ?? []).map((p) => p.playerName),
      ].filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];

  const map = await getMarketDeltasForPlayers(pool);

  const rows = Array.from(map.entries())
    .map(([playerName, delta]) => ({ playerName, delta }))
    .filter((row): row is { playerName: string; delta: MarketDelta } => row.delta !== null);

  const topGainers = rows
    .filter((r) => r.delta.pct7d > 0)
    .sort((a, b) => b.delta.pct7d - a.delta.pct7d)
    .slice(0, limitPerSide)
    .map((r) => ({ playerName: r.playerName, delta: r.delta, confidence: deriveConfidence(r.delta) }));

  const topLosers = rows
    .filter((r) => r.delta.pct7d < 0)
    .sort((a, b) => a.delta.pct7d - b.delta.pct7d)
    .slice(0, limitPerSide)
    .map((r) => ({ playerName: r.playerName, delta: r.delta, confidence: deriveConfidence(r.delta) }));

  // Notable sales — global feed used by both Market + Insights.
  const notable = await readNotableSales({
    minPrice: 500,
    days: 30,
    limit: 30,
  });

  return {
    id: "market",
    type: "market",
    docType: "daily_snapshot",
    publishedAt: new Date().toISOString(),
    publishedSlot: opts.slot,
    window: { selected: "7d", pct30dLabel: "30d %" },
    topGainers,
    topLosers,
    poolSize: pool.length,
    notableSales: notable.sales,
  };
}

// ─── Persistence ─────────────────────────────────────────────────

export async function saveMarketSnapshot(snapshot: MarketSnapshotDoc): Promise<boolean> {
  const c = await getContainer();
  if (!c) return false;
  await c.items.upsert(snapshot);
  return true;
}

export async function readLatestMarketSnapshot(): Promise<MarketSnapshotDoc | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item("market", "market").read<MarketSnapshotDoc>();
    return resource ?? null;
  } catch (err) {
    // 404 on a cold container is not an error — first publish hasn't fired yet.
    if ((err as { code?: number }).code === 404) return null;
    console.error("[dailyPublish] read latest failed:", err);
    return null;
  }
}

/** Convenience: compute + persist in one call. */
export async function publishMarketSnapshot(slot: "morning" | "evening"): Promise<MarketSnapshotDoc | null> {
  const snapshot = await computeMarketSnapshot({ slot });
  if (!snapshot) return null;
  const saved = await saveMarketSnapshot(snapshot);
  if (!saved) return null;
  return snapshot;
}
