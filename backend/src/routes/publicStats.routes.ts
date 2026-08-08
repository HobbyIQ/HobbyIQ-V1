// CF-PUBLIC-STATS (Drew, 2026-07-27). Small unauthenticated endpoint
// for the public landing page's "live numbers" strip. Returns approximate
// counts + a 30-day category-performance summary. NOT a data-as-a-product
// API (see project_no_public_data_api memory) — surfaces only aggregated
// counts, no card-level data or actionable pricing.
//
// Cached in-process for 15 minutes; a small Cosmos count call is cheap
// but landing traffic can be spiky at launch, so hold the payload.

import { Router, type Request, type Response } from "express";
import { CosmosClient } from "@azure/cosmos";

const router = Router();

interface PublicStats {
  soldCompsIndexed: number;
  // CF-CATALOG-COUNTS (Drew, 2026-08-05). Reflects the true unique-
  // card catalog (card_catalog container, pool-based rows). Was previously
  // the sold_comps-with-slug count — misleading because it counted
  // every transaction, not unique cards.
  cardsWithSlug: number;             // unique canonical cards in card_catalog
  productsIndexed: number;           // distinct product structures
  categories: number;
  sportsCovered: string[];
  // CF-NO-VENDOR-LEAK (Drew, 2026-08-05). NEVER expose data-source
  // names on the public API — that gives away our moat. Only count
  // is safe. The old vendorsIngested array field is removed.
  dataSourceCount: number;
  generatedAt: string;
}

interface Cache {
  payload: PublicStats;
  expiresAt: number;
}
let cache: Cache | null = null;
// CF-LIVE-STATS-STABILITY (Drew, 2026-08-08). Two-part fix:
//
// 1. Cache TTL bumped 15s → 5min. Prior 15s meant nearly every request
//    could race Cosmos cross-partition COUNT queries. sold_comps at
//    3.9M rows + card_catalog at 5.7M rows chew through RU budget on
//    every scan — at card_catalog's 4K RU cap the query can take
//    10-30s or 429-throttle entirely, and the endpoint returned
//    hardcoded fallback numbers (3.8M / 3.5M), making the LiveStatsStrip
//    counter visibly go BACKWARDS. 5min cache = ~12 Cosmos hits/hour
//    instead of ~240, essentially eliminating throttling pressure.
//
// 2. Last-known-good persistence — when fetchLiveStats returns null
//    (timeout, throttle, etc.), the cache serves the PREVIOUS cached
//    value instead of the hardcoded fallback constants. Counter never
//    regresses; at worst it stops advancing until the next successful
//    query.
//
// 3. Single-flight inflight guard — concurrent requests during a cache
//    miss share the same promise instead of each firing their own
//    cross-partition scan.
const TTL_MS = 5 * 60 * 1000;
let inflight: Promise<PublicStats | null> | null = null;

async function fetchLiveStats(): Promise<PublicStats | null> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const soldComps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    const cardCatalog = db.container("card_catalog");

    // Cross-partition COUNTs run in parallel — each is cheap on Cosmos
    // via aggregate SQL.
    //
    // CF-CARDSWITHSLUG-BROADEN (Drew, 2026-08-05). Now counts EVERY
    // card_catalog row, not just pool-built + ingest-auto-seed. The
    // filtered variant was under-reporting the true catalog depth by
    // ~4.5x (786K of 3.53M rows visible). BCCP/CLC/TCDB product-page
    // rows ARE canonical entries — they represent products we've
    // scraped and structured for downstream matching. Landing page
    // wants to show catalog breadth, not just the pool-verified slice.
    const [
      { resources: soldTotal },
      { resources: catalogTotal },
      { resources: productsTotal },
    ] = await Promise.all([
      soldComps.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }).fetchAll(),
      cardCatalog.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }).fetchAll(),
      cardCatalog.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'bccp-product-structure' OR c.source = 'clc-product-structure' OR c.source = 'tcdb-set-index'" }).fetchAll(),
    ]);

    return {
      soldCompsIndexed: Number(soldTotal[0] ?? 0),
      cardsWithSlug: Number(catalogTotal[0] ?? 0),
      productsIndexed: Number(productsTotal[0] ?? 0),
      categories: 4,
      sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
      dataSourceCount: 6,
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

const FALLBACK_ON_COLD_START: PublicStats = {
  // Only used when the endpoint has never had a successful Cosmos
  // fetch AND cache is empty (first cold start after restart, before
  // any query succeeds). Any later failure serves stale-but-real
  // cached values instead.
  soldCompsIndexed: 3_900_000,
  cardsWithSlug: 5_700_000,
  productsIndexed: 3_600,
  categories: 4,
  sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
  dataSourceCount: 6,
  generatedAt: new Date().toISOString(),
};

router.get("/public", async (_req: Request, res: Response) => {
  const now = Date.now();
  // Fresh cache — serve immediately.
  if (cache && cache.expiresAt > now) {
    res.set("Cache-Control", "public, max-age=60");
    res.json(cache.payload);
    return;
  }
  // Cache expired — single-flight: concurrent requests await the same fetch.
  if (!inflight) {
    inflight = fetchLiveStats().finally(() => { inflight = null; });
  }
  const fresh = await inflight;
  if (fresh) {
    // Successful fetch — advance the cache.
    cache = { payload: fresh, expiresAt: now + TTL_MS };
    res.set("Cache-Control", "public, max-age=60");
    res.json(fresh);
    return;
  }
  // Fetch failed — serve the LAST-KNOWN-GOOD cached value (never
  // regress the counter). Extend the expiry a bit so we don't hammer
  // Cosmos while it's clearly struggling.
  if (cache) {
    cache.expiresAt = now + 60_000;   // 1 min recheck cadence during Cosmos trouble
    res.set("Cache-Control", "public, max-age=60");
    res.json(cache.payload);
    return;
  }
  // Truly cold start with no prior success — serve the safety-net floor.
  cache = { payload: FALLBACK_ON_COLD_START, expiresAt: now + 60_000 };
  res.set("Cache-Control", "public, max-age=60");
  res.json(FALLBACK_ON_COLD_START);
});

export default router;
