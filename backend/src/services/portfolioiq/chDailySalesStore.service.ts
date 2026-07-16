// CF-CH-DAILY-EXPORT-INGEST (Drew, 2026-07-16). Cosmos store for the
// per-day CardHedge sale rows the ingest worker pulls from the bulk
// export endpoint.
//
// Container:    ch_daily_sales
// Partition:    /card_id
// Doc id:       price_history_id  (Bubble-style, globally unique per
//               CH row → idempotent by construction)
// TTL:          365 days (default; enough for annual seasonality
//               derivations, capped so storage stays bounded).
//
// Reads happen against per-card queries: `getSalesByCardId(cardId,
// {sinceIso, limit})`. Partition-hit; hot path stays cheap even as
// the container grows into millions of rows.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { CHDailySaleRow } from "../../types/chDailySales.types.js";

const DEFAULT_TTL_SEC = 365 * 24 * 3600;

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
      const containerId = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
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
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ch_daily_sales_init_failed",
        source: "chDailySalesStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Shape written to Cosmos. `id` and the partition key `card_id` both
 * required by Cosmos; the rest of the fields are the row verbatim.
 */
export interface CHDailySaleDoc extends CHDailySaleRow {
  id: string;      // = price_history_id
  ttl?: number;    // per-doc TTL override (unset → container default)
}

/**
 * Upsert a batch of rows in parallel. Returns per-row success flags
 * so the ingest job can log partial-failure counts without a
 * throw-abort. `concurrency` bounds Cosmos RU pressure — default 16
 * matches the pattern used elsewhere in the store layer.
 */
export async function upsertDailySalesBatch(
  rows: ReadonlyArray<CHDailySaleRow>,
  opts: { concurrency?: number } = {},
): Promise<{ upserted: number; failed: number; firstError: string | null }> {
  const c = await getContainer();
  if (!c) return { upserted: 0, failed: rows.length, firstError: "container unavailable" };

  const concurrency = Math.max(1, Math.min(64, opts.concurrency ?? 16));
  let upserted = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (let i = 0; i < rows.length; i += concurrency) {
    const slice = rows.slice(i, i + concurrency);
    await Promise.all(slice.map(async (row) => {
      try {
        const doc: CHDailySaleDoc = { id: row.price_history_id, ...row };
        await c.items.upsert(doc);
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
 * Read every sale row for a card, optionally filtered to a rolling
 * window. Partition-hit by cardId; safe to call from the hot pricing
 * path once bulk-read is wired in.
 *
 * `sinceIso` filters `sale_date >= sinceIso`. Pass a 90-day-ago
 * timestamp for comp pool freshness matching the existing engine.
 */
export async function getSalesByCardId(
  cardId: string,
  opts: { sinceIso?: string; limit?: number } = {},
): Promise<CHDailySaleDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const parameters: Array<{ name: string; value: string | number }> = [];
  let filter = "";
  if (opts.sinceIso) {
    parameters.push({ name: "@since", value: opts.sinceIso });
    filter = " AND c.sale_date >= @since";
  }
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 5000) : 500;
  const query = `SELECT TOP ${limit} * FROM c WHERE c.card_id = @cardId${filter} ORDER BY c.sale_date DESC`;
  parameters.unshift({ name: "@cardId", value: cardId });

  try {
    const { resources } = await c.items.query({ query, parameters }, { partitionKey: cardId }).fetchAll();
    return (resources ?? []) as CHDailySaleDoc[];
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_daily_sales_read_error",
      source: "chDailySalesStore.service",
      cardId,
      error: err?.message ?? String(err),
    }));
    return [];
  }
}

/**
 * Ingest-side checkpoint marker. Written after a successful ingest
 * completes so the next run can skip files it has already processed.
 * Doc id `checkpoint::${fileDate}` in the same container (occupies a
 * dedicated partition key of `_checkpoint` so it never hits a real
 * card's read path).
 */
export interface IngestCheckpoint {
  id: string;
  card_id: "_checkpoint";
  fileDate: string;                 // YYYY-MM-DD
  rowsUpserted: number;
  rowsFailed: number;
  completedAt: string;
  csvSizeBytes: number | null;
  firstError: string | null;
}

export async function writeIngestCheckpoint(cp: {
  fileDate: string;
  rowsUpserted: number;
  rowsFailed: number;
  csvSizeBytes: number | null;
  firstError: string | null;
}): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  const doc: IngestCheckpoint = {
    id: `checkpoint::${cp.fileDate}`,
    card_id: "_checkpoint",
    fileDate: cp.fileDate,
    rowsUpserted: cp.rowsUpserted,
    rowsFailed: cp.rowsFailed,
    completedAt: new Date().toISOString(),
    csvSizeBytes: cp.csvSizeBytes,
    firstError: cp.firstError,
  };
  try {
    await c.items.upsert(doc as any);
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_daily_sales_checkpoint_error",
      source: "chDailySalesStore.service",
      fileDate: cp.fileDate,
      error: err?.message ?? String(err),
    }));
  }
}

export async function readIngestCheckpoint(fileDate: string): Promise<IngestCheckpoint | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item(`checkpoint::${fileDate}`, "_checkpoint").read<IngestCheckpoint>();
    return resource ?? null;
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.warn(JSON.stringify({
      event: "ch_daily_sales_checkpoint_read_error",
      source: "chDailySalesStore.service",
      fileDate,
      error: err?.message ?? String(err),
    }));
    return null;
  }
}

/** Test hook — inject a fake container so unit tests don't need Cosmos. */
export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
