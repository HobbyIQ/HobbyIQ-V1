// trend_history Cosmos writer + reader.
//
// Fire-and-forget snapshot of every broaderTrend computed by /api/compiq/estimate.
// Deduplicated by an in-memory Map<cardId, lastWriteTs> with a 60-minute TTL —
// resets on server restart (acceptable: first call after restart writes one
// extra snapshot, never blocks the request, never throws).
//
// Cosmos:
//   db = COSMOS_DB ?? "hobbyiq"
//   container = "trend_history"
//   partition key = /cardId
//   doc id = `${cardId}_${timestamp}`
//
// All errors are caught and console.warn'd. This service must never throw.

import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { BroaderTrend } from "../compiq/compiqEstimate.service.js";
import type { TrendSnapshot } from "../../types/playerScore.js";

const DB_NAME = process.env.COSMOS_DB ?? process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_NAME =
  process.env.COSMOS_TREND_HISTORY_CONTAINER ?? "trend_history";

const RATE_LIMIT_MS = 60 * 60 * 1000; // 60 minutes per cardId
const lastWriteByCardId = new Map<string, number>();

let cachedContainer: Container | null = null;
let initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const conn = process.env.COSMOS_CONNECTION_STRING;
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;

      let client: CosmosClient | null = null;
      if (conn) {
        client = new CosmosClient(conn);
      } else if (endpoint && key) {
        client = new CosmosClient({ endpoint, key });
      } else if (endpoint) {
        client = new CosmosClient({
          endpoint,
          aadCredentials: new DefaultAzureCredential(),
        });
      } else {
        return null;
      }

      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ["/cardId"] },
      });
      cachedContainer = container;
      return container;
    } catch (err) {
      console.warn(
        "[trendHistory] init failed:",
        (err as Error).message
      );
      return null;
    }
  })();

  return initPromise;
}

export interface TrendSnapshotInput {
  cardId: string;
  playerName: string;
  year: number | null;
  set: string | null;
  cardNumber: string | null;
  grade: string;
  broaderTrend: BroaderTrend;
  fairMarketValue: number | null;
  anchorPrice: number | null;
}

/**
 * Fire-and-forget. Writes a TrendSnapshot to Cosmos `trend_history`.
 * Rate-limited to one write per cardId per 60 minutes (in-memory).
 *
 * Never throws. Never blocks. Returns immediately.
 */
export function writeTrendSnapshot(input: TrendSnapshotInput): void {
  // Skip writes that have no useful signal — keeps the container clean.
  if (!input.cardId || input.broaderTrend.basedOn === "insufficient") return;

  const now = Date.now();
  const last = lastWriteByCardId.get(input.cardId);
  if (last && now - last < RATE_LIMIT_MS) return;
  // Pre-mark to deduplicate concurrent calls before the async write resolves.
  lastWriteByCardId.set(input.cardId, now);

  void (async () => {
    try {
      const container = await getContainer();
      if (!container) {
        // Rollback the rate-limit marker so the next call can retry once Cosmos comes back.
        lastWriteByCardId.delete(input.cardId);
        return;
      }

      const timestamp = new Date(now).toISOString();
      const doc: TrendSnapshot = {
        id: `${input.cardId}_${now}`,
        cardId: input.cardId,
        playerName: input.playerName,
        year: input.year,
        set: input.set,
        cardNumber: input.cardNumber,
        grade: input.grade,
        impliedTrendPct: input.broaderTrend.impliedTrendPct,
        direction: input.broaderTrend.direction,
        basedOn: input.broaderTrend.basedOn,
        recentMedian: input.broaderTrend.recentMedian,
        olderMedian: input.broaderTrend.olderMedian,
        recentCount: input.broaderTrend.recentCount,
        olderCount: input.broaderTrend.olderCount,
        similarCardsScanned: input.broaderTrend.similarCardsScanned,
        totalSamples: input.broaderTrend.totalSamples,
        fairMarketValue: input.fairMarketValue,
        anchorPrice: input.anchorPrice,
        timestamp,
      };

      await container.items.create(doc);
    } catch (err) {
      console.warn(
        "[trendHistory] write failed:",
        (err as Error).message
      );
    }
  })();
}

/**
 * Read recent trend_history docs for every card belonging to a given player.
 * Used by PlayerScoreService.computeMarketScore() to aggregate the player's
 * cards into a single market score.
 *
 * Returns [] on any failure.
 */
export async function getRecentSnapshotsByPlayer(
  playerName: string,
  windowDays = 7,
): Promise<TrendSnapshot[]> {
  try {
    const container = await getContainer();
    if (!container) return [];

    const sinceIso = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
    const { resources } = await container.items
      .query<TrendSnapshot>({
        query:
          'SELECT * FROM c WHERE c["playerName"] = @player AND c["timestamp"] >= @since',
        parameters: [
          { name: "@player", value: playerName },
          { name: "@since", value: sinceIso },
        ],
      })
      .fetchAll();
    return resources ?? [];
  } catch (err) {
    console.warn(
      "[trendHistory] query failed:",
      (err as Error).message
    );
    return [];
  }
}

/**
 * Read recent trend_history docs for a specific cardId. Used by the
 * iOS trend-detail sheet to render the per-card history chart.
 */
export async function getRecentSnapshotsByCardId(
  cardId: string,
  windowDays = 30,
): Promise<TrendSnapshot[]> {
  try {
    const container = await getContainer();
    if (!container) return [];

    const sinceIso = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
    const { resources } = await container.items
      .query<TrendSnapshot>({
        query:
          'SELECT * FROM c WHERE c["cardId"] = @cardId AND c["timestamp"] >= @since ORDER BY c["timestamp"] ASC',
        parameters: [
          { name: "@cardId", value: cardId },
          { name: "@since", value: sinceIso },
        ],
        // Same partition — single-partition query, cheap.
      }, { partitionKey: cardId })
      .fetchAll();
    return resources ?? [];
  } catch (err) {
    console.warn(
      "[trendHistory] cardId query failed:",
      (err as Error).message
    );
    return [];
  }
}
