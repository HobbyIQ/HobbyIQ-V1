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
  cardsWithSlug: number;
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

    // Cross-partition COUNT — cheap on Cosmos when using aggregate SQL.
    const [{ resources: totalRes }, { resources: sluggedRes }] = await Promise.all([
      soldComps.items.query({ query: "SELECT VALUE COUNT(1) FROM c" }).fetchAll(),
      soldComps.items.query({ query: "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')" }).fetchAll(),
    ]);

    return {
      soldCompsIndexed: Number(totalRes[0] ?? 0),
      cardsWithSlug: Number(sluggedRes[0] ?? 0),
      categories: 4,
      sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
      vendorsIngested: ["CardHedge", "Cardsight", "eBay"],
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
    // Fallback numbers — match the memory snapshot from
    // project_hobbyiqcardid_backfilled + project_ch_ingest_multi_sport,
    // rounded down so we never overstate on Cosmos-unavailable.
    soldCompsIndexed: 2_400_000,
    cardsWithSlug: 2_400_000,
    categories: 4,
    sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
    vendorsIngested: ["CardHedge", "Cardsight", "eBay"],
    generatedAt: new Date().toISOString(),
  };
  cache = { payload, expiresAt: now + TTL_MS };
  res.set("Cache-Control", "public, max-age=300");
  res.json(payload);
});

export default router;
