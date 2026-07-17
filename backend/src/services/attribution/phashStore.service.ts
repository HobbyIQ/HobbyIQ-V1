// CF-ATTRIBUTION-PHASE-1-DHASH (Drew, 2026-07-16). Cosmos stores for
// per-sale phash rows + per-card attribution stats.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type {
  CHSalePhashDoc,
  CHCardAttributionStats,
} from "../../types/chSalePhash.types.js";

const DEFAULT_TTL_SEC = 365 * 24 * 3600;

// ─── Container: ch_sale_phashes ───────────────────────────────────────

let _phashContainer: Container | null = null;
let _phashInit: Promise<Container | null> | null = null;

async function getPhashContainer(): Promise<Container | null> {
  if (_phashContainer) return _phashContainer;
  if (_phashInit) return _phashInit;
  _phashInit = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_CH_SALE_PHASHES_CONTAINER ?? "ch_sale_phashes";
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
        partitionKey: { paths: ["/card_id"] },
        defaultTtl: DEFAULT_TTL_SEC,
      });
      _phashContainer = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ch_sale_phashes_init_failed",
        source: "phashStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _phashInit;
}

export async function upsertPhashBatch(
  rows: ReadonlyArray<CHSalePhashDoc>,
  opts: { concurrency?: number } = {},
): Promise<{ upserted: number; failed: number; firstError: string | null }> {
  const c = await getPhashContainer();
  if (!c) return { upserted: 0, failed: rows.length, firstError: "container unavailable" };
  const concurrency = Math.max(1, Math.min(64, opts.concurrency ?? 16));
  let upserted = 0, failed = 0;
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += concurrency) {
    const slice = rows.slice(i, i + concurrency);
    await Promise.all(slice.map(async (row) => {
      try {
        await c.items.upsert(row);
        upserted++;
      } catch (err: any) {
        failed++;
        if (!firstError) firstError = err?.message ?? String(err);
      }
    }));
  }
  return { upserted, failed, firstError };
}

/**
 * Read all phash rows for a card_id. Partition-hit; used by the
 * clustering step.
 */
export async function getPhashesForCard(cardId: string): Promise<CHSalePhashDoc[]> {
  const c = await getPhashContainer();
  if (!c) return [];
  try {
    const { resources } = await c.items
      .query<CHSalePhashDoc>({
        query: "SELECT * FROM c WHERE c.card_id = @cardId",
        parameters: [{ name: "@cardId", value: cardId }],
      }, { partitionKey: cardId })
      .fetchAll();
    return (resources ?? []) as CHSalePhashDoc[];
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_sale_phashes_read_error",
      source: "phashStore.service",
      cardId,
      error: err?.message ?? String(err),
    }));
    return [];
  }
}

/**
 * Read the set of (card_id, price_history_id) values already hashed.
 * Used by the ingest orchestrator to skip work that landed on a prior
 * run. Cross-partition query — for a card_id-scoped read use
 * getPhashesForCard instead. Wrapped so cost tracking is centralized.
 */
export async function listHashedPriceHistoryIds(
  opts: { limit?: number } = {},
): Promise<Set<string>> {
  const c = await getPhashContainer();
  if (!c) return new Set();
  const limit = opts.limit ? Math.min(opts.limit, 100_000) : 100_000;
  try {
    const { resources } = await c.items
      .query<{ id: string }>({ query: `SELECT TOP ${limit} c.id FROM c` })
      .fetchAll();
    return new Set((resources ?? []).map((r) => r.id));
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_sale_phashes_list_error",
      source: "phashStore.service",
      error: err?.message ?? String(err),
    }));
    return new Set();
  }
}

// ─── Container: ch_card_attribution_stats ─────────────────────────────

let _statsContainer: Container | null = null;
let _statsInit: Promise<Container | null> | null = null;

async function getStatsContainer(): Promise<Container | null> {
  if (_statsContainer) return _statsContainer;
  if (_statsInit) return _statsInit;
  _statsInit = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_CH_ATTRIBUTION_STATS_CONTAINER ?? "ch_card_attribution_stats";
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
        partitionKey: { paths: ["/card_id"] },
        // No TTL — attribution stats are audit history.
      });
      _statsContainer = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ch_attribution_stats_init_failed",
        source: "phashStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _statsInit;
}

export async function upsertAttributionStats(
  stats: CHCardAttributionStats,
): Promise<boolean> {
  const c = await getStatsContainer();
  if (!c) return false;
  try {
    await c.items.upsert(stats);
    return true;
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_attribution_stats_upsert_error",
      source: "phashStore.service",
      cardId: stats.card_id,
      error: err?.message ?? String(err),
    }));
    return false;
  }
}

export async function readAttributionStats(cardId: string): Promise<CHCardAttributionStats | null> {
  const c = await getStatsContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item(cardId, cardId).read<CHCardAttributionStats>();
    return resource ?? null;
  } catch (err: any) {
    if (err?.code === 404) return null;
    return null;
  }
}

export function _setPhashContainerForTests(container: Container | null): void {
  _phashContainer = container;
  _phashInit = null;
}

export function _setStatsContainerForTests(container: Container | null): void {
  _statsContainer = container;
  _statsInit = null;
}
