// CF-CARD-VALUATION-HISTORY (Drew, 2026-07-13, PR #431): the FOUNDATION
// of an honest backtest. Every day we snapshot each tracked cardId's
// slope-based Market Value + Predicted Price + verdict so future
// analysis can ask "what did the model say on 2026-07-14?" without
// re-running the math against comps that hadn't happened yet.
//
// Without this container, the backtest engine has a look-ahead bias
// baked in structurally — there's no way to compute historical MV
// "as of" a past date because CH's comp query returns whatever's
// current. This is why we build the snapshot table BEFORE the
// backtest engine, not after.
//
// Container: `card_valuation_history`, partition `/cardId`. 180-day
// TTL. One doc per (cardId, YYYY-MM-DD).
//
// Guards enforced at write time:
//   - Every doc records `computedAt` (the moment we froze the value)
//     — auditable against Cosmos _ts if ever needed
//   - Every doc records `sampleCount` (n comps behind the regression)
//     so downstream can gate on confidence
//   - Idempotent (cardId, date) upsert — same-day recomputes overwrite,
//     never duplicate

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const TTL_SEC = 180 * 24 * 3600;

type Verdict =
  | "strong_bull" | "bull" | "mixed" | "supply_tight" | "static"
  | "oversupply" | "bear" | "soft" | "weak" | "unavailable";

export interface ValuationHistoryDoc {
  id: string;                    // `{cardId}::{YYYY-MM-DD}`
  cardId: string;                // partition key
  date: string;                  // YYYY-MM-DD
  playerName: string | null;
  marketValue: number | null;
  predictedPrice: number | null;
  salesDirection: "up" | "down" | "static" | null;
  salesSlopePerMonthPct: number | null;
  listingsDirection: "up" | "down" | "static" | null;
  listingsSlopePerMonthPct: number | null;
  verdict: Verdict;
  sampleCount: number;           // comps used in the regression
  source: "compiq-estimate" | "cardsight-uuid" | "manual";
  computedAt: string;             // ISO timestamp of the snapshot
  ttl: number;
}

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
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId =
        process.env.COSMOS_CARD_VALUATION_HISTORY_CONTAINER ?? "card_valuation_history";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/cardId"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "card_valuation_history_init_failed",
        source: "cardValuationHistoryStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Persist today's valuation for a card. Idempotent — same (cardId, date)
 * upsert overwrites. Guards enforced:
 *   - Rejects docs without a cardId (nothing to key on)
 *   - `verdict` defaults to "unavailable" if caller doesn't supply one
 *     (never let the field be missing — downstream backtest joins need it)
 *   - `sampleCount` defaults to 0 (transparent about thin-data snapshots)
 *   - `computedAt` always set server-side (never trust caller clock)
 */
export async function upsertValuationSnapshot(input: {
  cardId: string;
  playerName?: string | null;
  marketValue?: number | null;
  predictedPrice?: number | null;
  salesDirection?: "up" | "down" | "static" | null;
  salesSlopePerMonthPct?: number | null;
  listingsDirection?: "up" | "down" | "static" | null;
  listingsSlopePerMonthPct?: number | null;
  verdict?: Verdict;
  sampleCount?: number;
  source: ValuationHistoryDoc["source"];
  today?: string;                // YYYY-MM-DD; defaults to today UTC
}): Promise<void> {
  if (!input.cardId) return;
  const c = await getContainer();
  if (!c) return;
  const date = input.today ?? new Date().toISOString().slice(0, 10);
  const doc: ValuationHistoryDoc = {
    id: `${input.cardId}::${date}`,
    cardId: input.cardId,
    date,
    playerName: input.playerName ?? null,
    marketValue: input.marketValue ?? null,
    predictedPrice: input.predictedPrice ?? null,
    salesDirection: input.salesDirection ?? null,
    salesSlopePerMonthPct: input.salesSlopePerMonthPct ?? null,
    listingsDirection: input.listingsDirection ?? null,
    listingsSlopePerMonthPct: input.listingsSlopePerMonthPct ?? null,
    verdict: input.verdict ?? "unavailable",
    sampleCount: input.sampleCount ?? 0,
    source: input.source,
    computedAt: new Date().toISOString(),
    ttl: TTL_SEC,
  };
  try {
    await c.items.upsert(doc as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "card_valuation_history_upsert_error",
      source: "cardValuationHistoryStore.service",
      cardId: input.cardId,
      date,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/**
 * Read valuation snapshots for a cardId, oldest → newest, bounded by
 * a maximum date. The `maxDate` guard is the KEY look-ahead protection
 * for backtests: callers pass in the sell-date, and this method never
 * returns snapshots dated AFTER that day.
 */
export async function readValuationHistory(input: {
  cardId: string;
  fromDate?: string;             // YYYY-MM-DD (inclusive); defaults to 180d ago
  maxDate?: string;              // YYYY-MM-DD (inclusive); default is today
}): Promise<ValuationHistoryDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const now = new Date();
  const from = input.fromDate ?? new Date(now.getTime() - 180 * 86_400_000)
    .toISOString().slice(0, 10);
  const to = input.maxDate ?? now.toISOString().slice(0, 10);
  const q = {
    query:
      "SELECT * FROM c WHERE c.cardId = @cid AND c.date >= @from AND c.date <= @to ORDER BY c.date",
    parameters: [
      { name: "@cid", value: input.cardId },
      { name: "@from", value: from },
      { name: "@to", value: to },
    ],
  };
  try {
    const { resources } = await c.items.query(q, { partitionKey: input.cardId }).fetchAll();
    return resources as ValuationHistoryDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "card_valuation_history_read_error",
      source: "cardValuationHistoryStore.service",
      cardId: input.cardId,
      error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
