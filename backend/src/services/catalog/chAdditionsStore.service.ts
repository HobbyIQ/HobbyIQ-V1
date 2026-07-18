// CF-CH-ADDITIONS-INGEST (Drew, 2026-07-17). Cosmos R/W on
// `ch_catalog_additions`. Partition /addedDate, doc id
// `{addedDate}::{category}::{setName}::{subset}` — idempotent
// upserts, so re-runs of overlapping windows write the same row
// once. Checkpoint doc under the same container uses doc id
// `checkpoint::additions` in a reserved partition.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { CardHedgeAdditionRow } from "../compiq/cardhedge.client.js";

const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_ID = process.env.COSMOS_CH_CATALOG_ADDITIONS_CONTAINER ?? "ch_catalog_additions";

/** Stored shape adds a stable id. */
export interface StoredCatalogAddition extends CardHedgeAdditionRow {
  id: string;
  ingestedAt: string;
}

export interface CatalogAdditionsCheckpoint {
  id: "checkpoint::additions";
  addedDate: "_meta";                   // reserved partition value
  lastRunStart: string;                 // ISO
  lastRunEnd: string;                   // ISO
  lastEndDate: string;                  // YYYY-MM-DD — highest addedDate seen
  rowsUpserted: number;
  updatedAt: string;
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
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_ID,
        partitionKey: { paths: ["/addedDate"] },
      });
      _container = container;
      return container;
    } catch {
      return null;
    }
  })();
  return _initPromise;
}

export function _setContainerForTesting(c: Container | null): void {
  _container = c;
  _initPromise = null;
}

/** Idempotent doc id per (category, set, subset, date). Safe re-run. */
function additionRowId(row: CardHedgeAdditionRow): string {
  const safe = (s: string | null | undefined) => (s ?? "").replace(/::/g, "__").replace(/[/\\?#]/g, "_").trim();
  return `${safe(row.added_date)}::${safe(row.category)}::${safe(row.set_name)}::${safe(row.subset)}`;
}

export async function upsertAdditions(rows: CardHedgeAdditionRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const c = await getContainer();
  if (!c) return 0;
  let n = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    try {
      // Cosmos partition key must exist as a top-level field. We shadow
      // added_date onto `addedDate` (camelCase) since our partition path
      // uses that convention.
      const doc: StoredCatalogAddition & { addedDate: string } = {
        ...row,
        id: additionRowId(row),
        addedDate: row.added_date,
        ingestedAt: now,
      };
      await c.items.upsert(doc);
      n++;
    } catch {
      // best-effort — a single row failure shouldn't kill the batch
    }
  }
  return n;
}

/** Read additions in a date window, sorted by added_date DESC. */
export async function readAdditionsSince(
  sinceDate: string,
  opts: { limit?: number; category?: string } = {},
): Promise<StoredCatalogAddition[]> {
  const c = await getContainer();
  if (!c) return [];
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  try {
    const params: Array<{ name: string; value: string | number }> = [
      { name: "@since", value: sinceDate },
      { name: "@lim", value: limit },
    ];
    let filter = "c.addedDate >= @since";
    if (opts.category) {
      filter += " AND c.category = @cat";
      params.push({ name: "@cat", value: opts.category });
    }
    const iter = c.items.query<StoredCatalogAddition>({
      query: `SELECT TOP @lim * FROM c WHERE ${filter} ORDER BY c.addedDate DESC`,
      parameters: params,
    }, { maxItemCount: limit });
    const out: StoredCatalogAddition[] = [];
    while (iter.hasMoreResults()) {
      const page = await iter.fetchNext();
      if (page.resources) out.push(...page.resources);
    }
    return out;
  } catch {
    return [];
  }
}

/** Read the checkpoint or null. */
export async function readCheckpoint(): Promise<CatalogAdditionsCheckpoint | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item("checkpoint::additions", "_meta").read<CatalogAdditionsCheckpoint>();
    return resource ?? null;
  } catch {
    return null;
  }
}

export async function upsertCheckpoint(input: Omit<CatalogAdditionsCheckpoint, "id" | "addedDate" | "updatedAt">): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  try {
    const doc: CatalogAdditionsCheckpoint = {
      id: "checkpoint::additions",
      addedDate: "_meta",
      updatedAt: new Date().toISOString(),
      ...input,
    };
    await c.items.upsert(doc);
  } catch {
    /* silent */
  }
}
