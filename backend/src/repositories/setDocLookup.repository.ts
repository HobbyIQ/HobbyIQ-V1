// CF-NO-NULL-PRICING PR 3 (2026-07-11, Drew — SetDoc lookup).
//
// Queries the `reference-catalog` container (shared with the parallel
// catalog) for SetDoc rows matching a (product, year) input. Used by
// Tier 7 fallback to identify the set's type + manufacturer + era.
//
// The reference-catalog container is already provisioned by
// referenceCatalog.repository.ts. This module reuses that lazy-init
// pattern for the SetDoc read side.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

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
        return null;
      }

      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else {
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
      return container;
    } catch (err: unknown) {
      console.warn(
        "[setDocLookup.repository] init failed:",
        (err as Error)?.message ?? err,
      );
      return null;
    }
  })();
  return _initPromise;
}

// ─── Slug helper — same as shared/slug ────────────────────────────────────

function slug(input: string): string {
  return String(input)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘"`]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Cache ────────────────────────────────────────────────────────────────

interface SetDocLookupResult {
  productKey: string;
  setName: string;
  manufacturer: string;
  setType: string;
  setSize: number | null;
  yearText: string;
  sortYear: number;
  confidence: string;
}

const _cache = new Map<string, SetDocLookupResult | null>();

function cacheKey(pk: string, year: number): string {
  return `${pk}|${year}`;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Look up a SetDoc for (product, year). Returns null on miss / error.
 * Never throws.
 *
 * Product is slugified before matching. Year matches against SetDoc's
 * `sortYear` field (extracted from yearText at ingest time).
 */
export async function getSetDocForProductYear(
  product: string | null | undefined,
  year: number | null | undefined,
): Promise<SetDocLookupResult | null> {
  if (!product || typeof product !== "string" || !product.trim()) return null;
  if (!year || !Number.isFinite(year)) return null;

  const productKey = slug(product);
  if (!productKey) return null;

  const key = cacheKey(productKey, year);
  const cached = _cache.get(key);
  if (cached !== undefined) return cached;

  const container = await getContainer();
  if (!container) {
    _cache.set(key, null);
    return null;
  }

  try {
    const { resources } = await container.items
      .query<SetDocLookupResult>({
        query:
          "SELECT c.productKey, c.setName, c.manufacturer, c.setType, c.setSize, c.yearText, c.sortYear, c.confidence FROM c WHERE c.productKey = @pk AND c.docType = 'set' AND c.sortYear = @y",
        parameters: [
          { name: "@pk", value: productKey },
          { name: "@y", value: year },
        ],
      })
      .fetchAll();
    const doc = resources[0] ?? null;
    _cache.set(key, doc);
    return doc;
  } catch (err) {
    console.warn(
      `[setDocLookup.repository] query failed (${productKey}, ${year}):`,
      (err as Error)?.message ?? err,
    );
    _cache.set(key, null);
    return null;
  }
}

export function _resetSetDocLookupCacheForTest(): void {
  _cache.clear();
}
