// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4). Cosmos-backed store
// for the parallels + vintage-set reference dataset. Follows the exact
// pattern of searchAliases.repository.ts (lazy createIfNotExists at first
// use, managed-identity fallback when no connection string / key).
//
// Container: reference-catalog, partition key /productKey.
// Doc shape: ParallelDoc | SetDoc (both discriminated by docType).

import { CosmosClient, Container, JSONObject } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { ParallelDoc, ReferenceDoc } from "../services/reference/referenceCatalog.types.js";

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
      const containerName =
        process.env.COSMOS_REFERENCE_CATALOG_CONTAINER ?? "reference-catalog";

      if (!endpoint && !connStr) {
        console.warn(
          "[referenceCatalog.repository] COSMOS not configured — repository disabled",
        );
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/productKey"] },
      });
      _container = container;
      console.log(
        `[referenceCatalog.repository] Cosmos container ready: ${dbName}/${containerName}`,
      );
      return container;
    } catch (err: unknown) {
      console.error(
        "[referenceCatalog.repository] init failed:",
        (err as Error)?.message ?? err,
      );
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Bulk-upsert a batch of ParallelDoc / SetDoc. Idempotent — same id
 * always overwrites the same document. Cosmos bulk operations are
 * chunked at 100 per call (SDK-imposed limit).
 *
 * Returns per-item outcome so the CLI can print a summary + escalate
 * to the read-back reconciliation gate.
 */
export interface BulkUpsertOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; message: string }>;
}

export async function bulkUpsertReferenceDocs(
  docs: ReferenceDoc[],
): Promise<BulkUpsertOutcome> {
  const container = await getContainer();
  if (!container) {
    return {
      attempted: docs.length,
      succeeded: 0,
      failed: docs.length,
      errors: [
        {
          id: "(container-init)",
          message: "COSMOS not configured — bulkUpsert skipped",
        },
      ],
    };
  }

  const outcome: BulkUpsertOutcome = {
    attempted: docs.length,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  const CHUNK = 100;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = docs.slice(i, i + CHUNK);
    const ops = batch.map((doc) => ({
      operationType: "Upsert" as const,
      partitionKey: doc.productKey,
      resourceBody: doc as unknown as JSONObject,
    }));
    try {
      const results = await container.items.bulk(ops);
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.statusCode >= 200 && r.statusCode < 300) {
          outcome.succeeded++;
        } else {
          outcome.failed++;
          outcome.errors.push({
            id: batch[j].id,
            message: `HTTP ${r.statusCode}`,
          });
        }
      }
    } catch (err: unknown) {
      // Whole-batch failure. Attribute the error to every id in the batch
      // so the CLI can report a clean count.
      const msg = (err as Error)?.message ?? String(err);
      for (const doc of batch) {
        outcome.failed++;
        outcome.errors.push({ id: doc.id, message: msg });
      }
    }
  }
  return outcome;
}

/**
 * Read-back count reconciliation — the CLI calls this after upsert to
 * verify parsed row count === Cosmos row count per productKey.
 */
export async function countDocsByProductKey(
  productKey: string,
): Promise<number | null> {
  const container = await getContainer();
  if (!container) return null;
  const { resources } = await container.items
    .query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.productKey = @pk",
      parameters: [{ name: "@pk", value: productKey }],
    })
    .fetchAll();
  return resources[0] ?? 0;
}

/**
 * List parallel documents for one product-year — powers
 * GET /api/reference/parallels?product=...&year=... in PR B.
 */
export async function listParallelsByProductYear(
  productKey: string,
  year: number,
): Promise<ParallelDoc[]> {
  const container = await getContainer();
  if (!container) return [];
  const { resources } = await container.items
    .query<ParallelDoc>({
      query:
        "SELECT * FROM c WHERE c.productKey = @pk AND c.docType = 'parallel' AND c.year = @y ORDER BY c.cardSet ASC, c.parallel ASC",
      parameters: [
        { name: "@pk", value: productKey },
        { name: "@y", value: year },
      ],
    })
    .fetchAll();
  return resources;
}

/**
 * Point-lookup by canonical (productKey, year, cardSetKey, parallelKey)
 * — powers the resolve endpoint's fast path in PR B when the caller
 * has already canonicalized. Returns null on miss.
 */
export async function getParallelByCanonicalKey(
  productKey: string,
  year: number,
  cardSetKey: string,
  parallelKey: string,
): Promise<ParallelDoc | null> {
  const container = await getContainer();
  if (!container) return null;
  const { resources } = await container.items
    .query<ParallelDoc>({
      query:
        "SELECT * FROM c WHERE c.productKey = @pk AND c.docType = 'parallel' AND c.year = @y AND c.cardSetKey = @cs AND c.parallelKey = @pl",
      parameters: [
        { name: "@pk", value: productKey },
        { name: "@y", value: year },
        { name: "@cs", value: cardSetKey },
        { name: "@pl", value: parallelKey },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * Fuzzy-fallback lookup used by the resolve endpoint when the exact
 * canonical key misses. Returns every parallel for the (productKey,
 * year) so the caller can score them against the input string.
 */
export async function listParallelsForFuzzyResolve(
  productKey: string,
  year: number,
): Promise<ParallelDoc[]> {
  return listParallelsByProductYear(productKey, year);
}
