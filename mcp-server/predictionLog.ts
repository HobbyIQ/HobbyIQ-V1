// Prediction logger — writes every CompIQ prediction to Cosmos DB so we can
// build training data + audit history. Fire-and-forget: never blocks or
// fails the prediction response.
//
// Cosmos: account from COSMOS_CONNECTION_STRING (or COSMOS_ENDPOINT + COSMOS_KEY),
//   database = COSMOS_DB ?? "hobbyiq",
//   container = COSMOS_PREDICTIONS_CONTAINER ?? "compiq_predictions",
//   partition key: /player

import { CosmosClient, type Container } from "@azure/cosmos";
import type { CardComp, PriceResult } from "./pricing.js";
import type { CompsAnalytics } from "./compsAnalytics.js";

const DB_NAME = process.env.COSMOS_DB ?? "hobbyiq";
const CONTAINER_NAME =
  process.env.COSMOS_PREDICTIONS_CONTAINER ?? "compiq_predictions";

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
      } else {
        return null;
      }

      const { database } = await client.databases.createIfNotExists({
        id: DB_NAME,
      });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ["/player"] },
      });
      cachedContainer = container;
      return container;
    } catch (err) {
      console.warn(
        "[predictionLog] init failed:",
        (err as Error).message
      );
      return null;
    }
  })();

  return initPromise;
}

export interface PredictionLogEntry {
  // Card identity
  player: string; // partition key
  year: number;
  set: string;
  cardNumber: string;
  variant?: string;
  grade?: string;
  isRookie?: boolean;
  printRun?: number;

  // Inputs
  anchorPrice: number;
  compsCount: number;
  compsMedian: number;
  compsLow: number;
  compsHigh: number;

  // Outputs (full MCP prediction block)
  prediction: PriceResult;

  // Convenience top-level fields for ad-hoc Cosmos queries
  predicted72h: number;
  predicted7d: number;
  direction: string;
  confidence: number;
  recommendation: string;

  // Provenance
  source: "predict" | "prime";
  client?: string; // user-agent or X-Client-Id
  timestamp: string; // ISO8601

  // Phase A — time-series analytics input snapshot (audit + training data)
  analytics?: CompsAnalytics;
}

/**
 * Persist a prediction. Fire-and-forget: errors are logged, never thrown.
 */
export function logPrediction(entry: Omit<PredictionLogEntry, "timestamp">): void {
  const doc: PredictionLogEntry & { id: string } = {
    ...entry,
    timestamp: new Date().toISOString(),
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };

  void (async () => {
    try {
      const container = await getContainer();
      if (!container) return;
      await container.items.create(doc);
    } catch (err) {
      console.warn(
        "[predictionLog] write failed:",
        (err as Error).message
      );
    }
  })();
}

export function summarizeCompRange(comps: CardComp[]): {
  low: number;
  median: number;
  high: number;
} {
  if (!comps.length) return { low: 0, median: 0, high: 0 };
  const prices = comps.map((c) => c.price).sort((a, b) => a - b);
  return {
    low: prices[0],
    median: prices[Math.floor(prices.length / 2)],
    high: prices[prices.length - 1],
  };
}
