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

  // CF-INGEST-RATE-LIMIT-BACKOFF (2026-07-10): the reference-catalog
  // container is auto-created at default 400 RU/s. Bulk-100 saturates
  // that budget instantly and Cosmos returns HTTP 429 per item. The SDK
  // does NOT auto-retry per-item 429s on bulk operations (that's for
  // single-item ops). So we retry any 429s in-place with exponential
  // backoff — cheap, correct, avoids touching container throughput.
  // At default 400 RU/s shared throughput, a bulk-100 batch (~1000 RU)
  // requires ~2.5s of RU recovery. Smaller batches + more retries +
  // inter-batch throttle drain cleanly without touching container config.
  const CHUNK = 25;
  const MAX_RETRIES = 30;
  const INTER_BATCH_MS = 250;
  for (let i = 0; i < docs.length; i += CHUNK) {
    if (i > 0) await new Promise((r) => setTimeout(r, INTER_BATCH_MS));
    const batch = docs.slice(i, i + CHUNK);
    let pending: typeof batch = batch;
    let attempt = 0;
    while (pending.length > 0 && attempt <= MAX_RETRIES) {
      const ops = pending.map((doc) => ({
        operationType: "Upsert" as const,
        partitionKey: doc.productKey,
        resourceBody: doc as unknown as JSONObject,
      }));
      try {
        const results = await container.items.bulk(ops);
        const nextPending: typeof pending = [];
        let maxRetryAfterMs = 0;
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.statusCode >= 200 && r.statusCode < 300) {
            outcome.succeeded++;
          } else if (r.statusCode === 429) {
            // Rate-limited — queue for retry.
            nextPending.push(pending[j]);
            const ra = (r as { retryAfterMilliseconds?: number })
              .retryAfterMilliseconds;
            if (typeof ra === "number" && ra > maxRetryAfterMs) {
              maxRetryAfterMs = ra;
            }
          } else {
            outcome.failed++;
            outcome.errors.push({
              id: pending[j].id,
              message: `HTTP ${r.statusCode}`,
            });
          }
        }
        pending = nextPending;
        if (pending.length === 0) break;
        attempt++;
        // Server-honored retry-after when present, else exponential backoff
        // capped at 10s. Higher cap gives a fully-saturated 400 RU/s
        // container time to fully recover before we hit it again.
        const backoff =
          maxRetryAfterMs > 0
            ? maxRetryAfterMs
            : Math.min(500 * Math.pow(1.5, attempt), 10000);
        await new Promise((r) => setTimeout(r, backoff));
      } catch (err: unknown) {
        const msg = (err as Error)?.message ?? String(err);
        for (const doc of pending) {
          outcome.failed++;
          outcome.errors.push({ id: doc.id, message: msg });
        }
        pending = [];
      }
    }
    // Anything still pending after MAX_RETRIES → tally as failed.
    for (const doc of pending) {
      outcome.failed++;
      outcome.errors.push({
        id: doc.id,
        message: `HTTP 429 (exhausted ${MAX_RETRIES} retries)`,
      });
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
  // CF-REFERENCE-CATALOG-ORDERBY-HOTFIX (2026-07-10): auto-created
  // container has default indexing policy without composite indexes,
  // so multi-column ORDER BY fails with "The order by query does not
  // have a corresponding composite index" — SDK then retries, hangs
  // the request for 60-90s. Sort client-side instead; buckets are
  // small (max ~400 rows for the largest productKey).
  const { resources } = await container.items
    .query<ParallelDoc>({
      query:
        "SELECT * FROM c WHERE c.productKey = @pk AND c.docType = 'parallel' AND c.year = @y",
      parameters: [
        { name: "@pk", value: productKey },
        { name: "@y", value: year },
      ],
    })
    .fetchAll();
  resources.sort((a, b) => {
    const setCmp = (a.cardSet ?? "").localeCompare(b.cardSet ?? "");
    if (setCmp !== 0) return setCmp;
    return (a.parallel ?? "").localeCompare(b.parallel ?? "");
  });
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
