// CF-VENDOR-PRICING-CACHE (Drew, 2026-07-13): Cosmos-backed persistent
// cache for multi-vendor resolutions.
//
// Rationale: the in-memory LRU (5000 entries, 6h TTL — added in PR #397)
// works but resets on every process restart AND is per-instance. With
// Azure App Service auto-scaling, cold instances re-hit vendor APIs.
// Cardsight has a ~100k/mo quota; every re-hit chips at it.
//
// This cache:
//   - Sits BETWEEN the in-memory LRU and the vendor fan-out
//   - Every winning resolution writes through to Cosmos (fire-and-forget)
//   - Every resolveCard call reads Cosmos on in-memory miss
//   - Per-vendor TTL: CH 6h, Cardsight 24h, sold-comps 6h
//
// Container: `vendor_pricing_cache`
// Partition key: `/cardId` — most reads are cardId lookups (from
// price-by-id + holding refresh); free-text search cache keys spread
// across many partitions, still O(1) point reads.
// TTL: Cosmos-native, per-document.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { CardResolution, SourceVendor } from "./catalogResolver.service.js";

// Per-vendor TTLs in seconds. Cardsight catalog is stable so we give it a
// full day; CH + sold-comps rebuild faster.
const TTL_BY_VENDOR: Record<SourceVendor, number> = {
  cardhedge: 6 * 3600,
  cardsight: 24 * 3600,
  ebay: 6 * 3600,
  "sold-comps": 6 * 3600,
  manual: 24 * 3600,
};

// Null-resolution cache TTL — prevents "everyone searches for the same
// missing card" from hammering vendors. 30 min gives fresh cards time
// to land in catalogs.
const NULL_RESOLUTION_TTL_SEC = 30 * 60;

interface CacheDoc {
  id: string;                    // canonical cache key
  cardId: string;                // partition key (winner's cardId, or "no-cardId" for null resolutions)
  resolution: CardResolution | null;
  cachedAt: string;              // ISO
  ttl: number;                   // Cosmos native TTL, seconds
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
        process.env.COSMOS_VENDOR_PRICING_CACHE_CONTAINER ?? "vendor_pricing_cache";
      if (!endpoint && !connStr) {
        console.warn(
          "[vendorPricingCache] No Cosmos config — service will no-op",
        );
        return null;
      }
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
        // -1 = TTL enabled but no default; per-doc `ttl` field applies.
        defaultTtl: -1,
      });
      console.log(JSON.stringify({
        event: "vendor_pricing_cache_ready",
        source: "vendorPricingCache.service",
        containerId,
      }));
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "vendor_pricing_cache_init_failed",
        source: "vendorPricingCache.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();

  return _initPromise;
}

/**
 * Read from the persistent cache. Returns null on miss / config-absent /
 * error. Never throws — safe to call on hot path.
 *
 * The cache is keyed by (id = canonicalCacheKey, cardId = partition).
 * Point reads are ~O(1) so this is cheap; adds ~15-30ms per call vs a
 * pure in-memory hit but saves 200-800ms vendor calls.
 */
export async function getCachedResolution(
  canonicalKey: string,
  cardId: string | null,
): Promise<CardResolution | null> {
  const container = await getContainer();
  if (!container) return null;
  const partitionKey = cardId ?? "no-cardId";
  try {
    const { resource } = await container.item(canonicalKey, partitionKey).read<CacheDoc>();
    if (!resource) return null;
    // Cosmos TTL sweep is asynchronous; item might still be readable after
    // logical expiry. Belt-and-suspenders: check cachedAt + TTL manually.
    const cachedMs = Date.parse(resource.cachedAt);
    if (Number.isFinite(cachedMs)) {
      const ageSec = (Date.now() - cachedMs) / 1000;
      if (ageSec > resource.ttl) return null;
    }
    return resource.resolution;
  } catch (err: any) {
    // 404 on point read is the miss case — normal.
    if (err?.code === 404) return null;
    console.warn(JSON.stringify({
      event: "vendor_pricing_cache_read_error",
      source: "vendorPricingCache.service",
      canonicalKey,
      error: err?.message ?? String(err),
    }));
    return null;
  }
}

/**
 * Write-through to the persistent cache. Fire-and-forget from the caller —
 * doesn't block user-facing latency. Never throws.
 */
export async function putCachedResolution(
  canonicalKey: string,
  resolution: CardResolution | null,
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const cardId = resolution?.cardId ?? "no-cardId";
  const ttl = resolution ? TTL_BY_VENDOR[resolution.vendor] : NULL_RESOLUTION_TTL_SEC;
  const doc: CacheDoc = {
    id: canonicalKey,
    cardId,
    resolution,
    cachedAt: new Date().toISOString(),
    ttl,
  };
  try {
    await container.items.upsert(doc as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "vendor_pricing_cache_write_error",
      source: "vendorPricingCache.service",
      canonicalKey,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}

/** Test hook — override the container for unit tests. */
export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
