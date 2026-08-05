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
  productsIndexed: number;           // distinct product structures (BCCP + CLC + TCDB)
  categories: number;
  sportsCovered: string[];
  vendorsIngested: string[];
  generatedAt: string;
}

interface Cache {
  payload: PublicStats;
  expiresAt: number;
}
let cache: Cache | null = null;
const TTL_MS = 15 * 60 * 1000;

async function fetchLiveStats(): Promise<PublicStats | null> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const soldComps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    const cardCatalog = db.container("card_catalog");

    // Cross-partition COUNTs run in parallel — each is cheap on Cosmos
    // via aggregate SQL. card_catalog contains the true unique-card
    // count (pool-built rows, one per canonical identity).
    const [
      { resources: soldTotal },
      { resources: catalogTotal },
      { resources: productsTotal },
    ] = await Promise.all([
      soldComps.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }).fetchAll(),
      cardCatalog.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'bulk-build-from-pool' OR c.source = 'ingest-auto-seed'" }).fetchAll(),
      cardCatalog.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'bccp-product-structure' OR c.source = 'clc-product-structure' OR c.source = 'tcdb-set-index'" }).fetchAll(),
    ]);

    return {
      soldCompsIndexed: Number(soldTotal[0] ?? 0),
      cardsWithSlug: Number(catalogTotal[0] ?? 0),
      productsIndexed: Number(productsTotal[0] ?? 0),
      categories: 4,
      sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
      vendorsIngested: ["CardHedge", "Cardsight", "eBay", "TCA", "baseballcardpedia", "checklistcenter"],
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

router.get("/public", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    res.set("Cache-Control", "public, max-age=300");
    res.json(cache.payload);
    return;
  }
  const fresh = await fetchLiveStats();
  const payload: PublicStats = fresh ?? {
    // Fallback numbers — refreshed 2026-08-05 from live counts. Round
    // down slightly so we never overstate on Cosmos-unavailable.
    soldCompsIndexed: 2_800_000,        // baseball alone is 2.85M as of 2026-08-05
    cardsWithSlug: 550_000,             // 559K baseball pool rows in card_catalog
    productsIndexed: 3_600,             // BCCP 3,075 + CLC 547 + TCDB (climbing)
    categories: 4,
    sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
    vendorsIngested: ["CardHedge", "Cardsight", "eBay", "TCA", "baseballcardpedia", "checklistcenter"],
    generatedAt: new Date().toISOString(),
  };
  cache = { payload, expiresAt: now + TTL_MS };
  res.set("Cache-Control", "public, max-age=300");
  res.json(payload);
});

export default router;
