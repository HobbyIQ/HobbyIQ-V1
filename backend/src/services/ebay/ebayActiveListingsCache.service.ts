// CF-EBAY-ACTIVE-LISTINGS-CACHE (Drew, 2026-07-17). 12-hour Cosmos
// cache for card-scoped eBay Browse results. Same card = same
// listings across all users, so caching once amortizes eBay Browse
// budget (5000 calls/day cap) across the whole userbase.
//
// Container: `ebay_active_listings_cache`, partition `/cardId`.
// TTL: 12h (43200s). Doc id: `{cardId}::{gradeTierSlug}`.

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { CardActiveListingsResult } from "./ebayListingSearch.service.js";

const TTL_SEC = 12 * 3600;

export interface CachedActiveListings {
  id: string;
  cardId: string;
  gradeTierSlug: string;         // "raw" or "psa-10" etc
  result: CardActiveListingsResult;
  fetchedAt: string;
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
        process.env.COSMOS_EBAY_ACTIVE_LISTINGS_CACHE_CONTAINER ?? "ebay_active_listings_cache";
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
        // defaultTtl=-1 means "TTL enabled, no default." Per-doc ttl
        // controls expiry. Each doc sets ttl=TTL_SEC on write.
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "ebay_active_listings_cache_init_error",
        source: "ebayActiveListingsCache.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

/** Test seam — inject or clear the container handle. */
export function _setContainerForTesting(c: Container | null): void {
  _container = c;
  _initPromise = null;
}

export function gradeTierSlug(
  gradeCompany?: string,
  gradeValue?: string,
): string {
  const c = (gradeCompany ?? "").trim().toLowerCase();
  const v = (gradeValue ?? "").trim().toLowerCase();
  if (!c || !v) return "raw";
  return `${c}-${v.replace(/\./g, "_")}`;
}

function cacheId(cardId: string, tier: string): string {
  return `${cardId}::${tier}`;
}

export async function readCachedActiveListings(
  cardId: string,
  gradeCompany?: string,
  gradeValue?: string,
): Promise<CardActiveListingsResult | null> {
  const container = await getContainer();
  if (!container) return null;
  const tier = gradeTierSlug(gradeCompany, gradeValue);
  try {
    const { resource } = await container.item(cacheId(cardId, tier), cardId).read<CachedActiveListings>();
    return resource?.result ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    console.warn(JSON.stringify({
      event: "ebay_active_listings_cache_read_error",
      source: "ebayActiveListingsCache.service",
      cardId, tier,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

export async function writeCachedActiveListings(
  cardId: string,
  gradeCompany: string | undefined,
  gradeValue: string | undefined,
  result: CardActiveListingsResult,
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const tier = gradeTierSlug(gradeCompany, gradeValue);
  const doc: CachedActiveListings = {
    id: cacheId(cardId, tier),
    cardId,
    gradeTierSlug: tier,
    result,
    fetchedAt: new Date().toISOString(),
    ttl: TTL_SEC,
  };
  try {
    await container.items.upsert(doc);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_active_listings_cache_write_error",
      source: "ebayActiveListingsCache.service",
      cardId, tier,
      error: (err as Error)?.message ?? String(err),
    }));
  }
}
