// CF-PHASE-6A-CANONICALIZATION (Drew, 2026-07-17). Cosmos store for the
// canonical entity table. One container shared across player/set/variant
// — partition by /canonical_id (guaranteed unique), doc id = canonical_id.
// Entity type is a filter field.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { CanonicalEntityDoc, CanonicalEntityType } from "../../types/chCanonical.types.js";

let _container: Container | null = null;
let _init: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_init) return _init;
  _init = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId = process.env.COSMOS_CH_CANONICAL_ENTITIES_CONTAINER ?? "ch_canonical_entities";
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
        partitionKey: { paths: ["/canonical_id"] },
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ch_canonical_entities_init_failed",
        source: "canonicalizationStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _init;
}

export async function upsertCanonicalEntity(entity: CanonicalEntityDoc): Promise<boolean> {
  const c = await getContainer();
  if (!c) return false;
  try {
    await c.items.upsert(entity);
    return true;
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_canonical_entities_upsert_error",
      canonicalId: entity.canonical_id,
      error: err?.message ?? String(err),
    }));
    return false;
  }
}

export async function upsertCanonicalBatch(
  entities: ReadonlyArray<CanonicalEntityDoc>,
  concurrency = 16,
): Promise<{ upserted: number; failed: number }> {
  const c = await getContainer();
  if (!c) return { upserted: 0, failed: entities.length };
  let upserted = 0;
  let failed = 0;
  for (let i = 0; i < entities.length; i += concurrency) {
    const slice = entities.slice(i, i + concurrency);
    await Promise.all(slice.map(async (e) => {
      const ok = await upsertCanonicalEntity(e);
      if (ok) upserted++;
      else failed++;
    }));
  }
  return { upserted, failed };
}

/**
 * Lookup by canonical_id. Partition-hit, cheap.
 */
export async function readCanonicalById(canonicalId: string): Promise<CanonicalEntityDoc | null> {
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item(canonicalId, canonicalId).read<CanonicalEntityDoc>();
    return resource ?? null;
  } catch (err: any) {
    if (err?.code === 404) return null;
    return null;
  }
}

/**
 * Enumerate all canonical entities of a given type. Cross-partition —
 * called once at startup by an in-memory alias index (Phase 6B).
 */
export async function listCanonicalEntitiesByType(
  entityType: CanonicalEntityType,
): Promise<CanonicalEntityDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  try {
    const { resources } = await c.items
      .query<CanonicalEntityDoc>({
        query: "SELECT * FROM c WHERE c.entity_type = @type",
        parameters: [{ name: "@type", value: entityType }],
      })
      .fetchAll();
    return resources ?? [];
  } catch (err: any) {
    console.warn(JSON.stringify({
      event: "ch_canonical_entities_list_error",
      entityType,
      error: err?.message ?? String(err),
    }));
    return [];
  }
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _init = null;
}
