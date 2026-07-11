// CF-NO-NULL-PRICING (2026-07-11, Drew — PR 2). Repository for the
// `era-baselines` Cosmos container. Follows the same lazy-init pattern
// as searchAliases.repository.ts and referenceCatalog.repository.ts.
//
// Read-side is a hot lookup consumed by Tier 6 on every fallback
// evaluation → in-process cache keyed by (productKey, year, cardClass)
// with lazy load-on-first-hit. Same "hot cache" discipline the
// projection-path hook needed.

import { CosmosClient, Container, JSONObject } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import {
  CardClass,
  EraBaselineDoc,
  ERA_BASELINE_SCHEMA_VERSION,
} from "../services/compiq/eraBaselines.types.js";
import { createHash } from "node:crypto";

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
        process.env.COSMOS_ERA_BASELINES_CONTAINER ?? "era-baselines";

      if (!endpoint && !connStr) {
        console.warn(
          "[eraBaselines.repository] COSMOS not configured — repository disabled",
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

      const { database } = await client.databases.createIfNotExists({
        id: dbName,
      });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/productKey"] },
      });
      _container = container;
      console.log(
        `[eraBaselines.repository] Cosmos container ready: ${dbName}/${containerName}`,
      );
      return container;
    } catch (err: unknown) {
      console.error(
        "[eraBaselines.repository] init failed:",
        (err as Error)?.message ?? err,
      );
      return null;
    }
  })();
  return _initPromise;
}

// ─── ID helper ────────────────────────────────────────────────────────────

export function eraBaselineDocId(
  productKey: string,
  year: number,
  cardClass: CardClass,
): string {
  const preimage = `${productKey}|${year}|${cardClass}`;
  return createHash("sha1").update(preimage).digest("hex");
}

// ─── In-process cache ────────────────────────────────────────────────────
//
// Keyed by (productKey, year, cardClass). Hit rate is dominated by
// hot recent-year buckets — a single Cosmos read per bucket per process
// lifetime. Empty responses ARE cached (marked as MISS) so we don't
// retry Cosmos on every request for the same absent bucket.

interface CacheEntry {
  doc: EraBaselineDoc | null;
  loadedAt: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheKey(pk: string, year: number, cardClass: CardClass): string {
  return `${pk}|${year}|${cardClass}`;
}

// ─── Public read API ─────────────────────────────────────────────────────

/**
 * Look up the era baseline for (productKey, year, cardClass).
 *
 * Returns null when:
 *   * Cosmos not configured / init failed
 *   * The bucket has no doc (empty for that tuple)
 *
 * Never throws. Tier 6 caller must be able to fall through to the
 * static table on a null return.
 */
export async function getEraBaseline(
  productKey: string,
  year: number,
  cardClass: CardClass,
): Promise<EraBaselineDoc | null> {
  if (!productKey || !Number.isFinite(year)) return null;
  const key = cacheKey(productKey, year, cardClass);
  const cached = _cache.get(key);
  if (cached) return cached.doc;

  const container = await getContainer();
  if (!container) {
    _cache.set(key, { doc: null, loadedAt: Date.now() });
    return null;
  }

  try {
    const id = eraBaselineDocId(productKey, year, cardClass);
    const { resource } = await container.item(id, productKey).read<EraBaselineDoc>();
    const doc = resource ?? null;
    _cache.set(key, { doc, loadedAt: Date.now() });
    return doc;
  } catch (err: unknown) {
    // 404 (not-found) is the expected "no data yet" case; log at debug.
    const status = (err as { code?: number })?.code;
    if (status === 404) {
      _cache.set(key, { doc: null, loadedAt: Date.now() });
      return null;
    }
    console.warn(
      `[eraBaselines.repository] read failed (${productKey}, ${year}, ${cardClass}):`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

// ─── Write API (used by PR 4's daily refresh job) ────────────────────────

export interface BulkUpsertOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; message: string }>;
}

export async function bulkUpsertEraBaselines(
  docs: EraBaselineDoc[],
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

  // Same rate-limit-aware pattern as reference-catalog.
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
    for (const doc of pending) {
      outcome.failed++;
      outcome.errors.push({
        id: doc.id,
        message: `HTTP 429 (exhausted ${MAX_RETRIES} retries)`,
      });
    }
  }

  // Invalidate in-process cache for touched buckets so next read
  // returns fresh data.
  for (const doc of docs) {
    _cache.delete(cacheKey(doc.productKey, doc.year, doc.cardClass));
  }

  return outcome;
}

// ─── Test hook — clear cache between test cases ──────────────────────────

export function _resetEraBaselineCacheForTest(): void {
  _cache.clear();
}

// Schema version re-export so callers can assert on it.
export { ERA_BASELINE_SCHEMA_VERSION };
