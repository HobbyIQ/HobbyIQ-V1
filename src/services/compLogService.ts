/**
 * Comp logging service — persists pricing outcomes to Azure Cosmos DB.
 *
 * Every successful searchAndPrice() call logs:
 *   - Card identity (player, year, parallel, grade, isAuto)
 *   - Raw comps used (title, price, date, compMatchTier, compQualityScore)
 *   - Final price + path + confidence
 *   - Trend signal (trendScore, direction, changePercent)
 *   - Timestamp
 *
 * This data is the prerequisite for Azure ML AutoML price forecasting and
 * Azure Anomaly Detector comp quality improvement.
 *
 * Gated by COSMOS_CONNECTION_STRING env var — silently no-ops when absent.
 * All writes are fire-and-forget; never blocks the pricing response.
 */

import { CosmosClient, Container } from "@azure/cosmos";

const DB_NAME = "hobbyiq";
const CONTAINER_NAME = "comp_logs";

export interface CompLogEntry {
  // Cosmos DB required fields
  id: string;               // UUID — unique per log entry
  player: string;           // partition key

  // Card identity
  query: string;
  year: number | null;
  parallel: string;
  variant: string;
  grade: string;
  isAuto: boolean;
  serialNumber: number | null;

  // Pricing outcome
  finalPrice: number;
  pricingPath: string;
  confidenceLabel: "High" | "Medium" | "Low";
  confidenceScore: number;
  trendScore: number | null;
  trendDirection: string | null;
  trendChangePct: number | null;

  // Comp evidence — up to 20 comps stored to keep document size bounded
  comps: Array<{
    title: string;
    price: number;
    date: string;
    compMatchTier: string;
    compQualityScore: number;
  }>;
  compCount: number;

  // ML features for AutoML training
  w7Count: number;
  w14Count: number;
  w30Count: number;
  w7Avg: number | null;
  w14Avg: number | null;
  w30Avg: number | null;
  activeListingCount: number | null;
  lowestAsk: number | null;

  // Metadata
  timestamp: string;        // ISO 8601
  epochMs: number;
  appVersion: string;
}

// ─── Singleton client ─────────────────────────────────────────────────────────

let container: Container | null = null;
let initAttempted = false;

function getContainer(): Container | null {
  if (initAttempted) return container;
  initAttempted = true;

  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) {
    // Silently disabled — no connection string configured
    return null;
  }

  try {
    const client = new CosmosClient(connStr);
    container = client.database(DB_NAME).container(CONTAINER_NAME);
    console.log("[compLog] Cosmos DB client initialized (lazy — first write will validate connectivity)");
    return container;
  } catch (err) {
    console.warn(`[compLog] Failed to initialize Cosmos client: ${(err as Error).message}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget comp log write. Never throws, never awaited on the hot path.
 */
export function logCompResult(entry: CompLogEntry): void {
  const c = getContainer();
  if (!c) return;

  c.items.upsert(entry).catch((err: Error) => {
    console.warn(`[compLog] Write failed for query="${entry.query.slice(0, 60)}": ${err.message}`);
  });
}

/**
 * Ensure the database and container exist. Called once at server startup.
 * Safe to call even if COSMOS_CONNECTION_STRING is not set.
 */
export async function ensureCompLogContainer(): Promise<void> {
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) return;

  try {
    const client = new CosmosClient(connStr);
    const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
    await database.containers.createIfNotExists({
      id: CONTAINER_NAME,
      partitionKey: { paths: ["/player"] },
      defaultTtl: 60 * 60 * 24 * 365 * 2, // 2-year TTL — old data auto-expires
    });
    console.log(`[compLog] Container ready: ${DB_NAME}/${CONTAINER_NAME}`);
  } catch (err) {
    console.warn(`[compLog] Container setup failed: ${(err as Error).message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeCompLogId(): string {
  // Compact sortable ID: timestamp prefix + 8 random hex chars
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}
