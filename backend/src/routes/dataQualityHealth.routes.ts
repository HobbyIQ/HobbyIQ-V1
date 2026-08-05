// CF-DATA-QUALITY-HEALTH (Drew, 2026-08-05).
//
// GET /api/health/data-quality — reports pool cleanliness so degradation
// (rising flag count, growing unlinked share, malformed slug creep)
// surfaces before the next FMV bug report.
//
// No auth — aggregates only, no card content. Cached 15 min because
// the underlying counts are expensive cross-partition aggregates.

import { Router, type Request, type Response } from "express";
import { CosmosClient } from "@azure/cosmos";

const router = Router();

interface FlagStat {
  reason: string;
  count: number;
  sample: string | null;   // sample slug for spot-check
}

interface DataQualityResponse {
  now: string;
  totals: {
    soldComps: number;
    flaggedWrong: number;
    flaggedWrongPct: number;
    excludedFromFmv: number;
    priceOutlier: number;
    malformedSlugs: number;
    unlinkedToTree: number;
  };
  flagsByReason: FlagStat[];
  perSource: Array<{ source: string; total: number; flagged: number; flaggedPct: number }>;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
let cached: { at: number; payload: DataQualityResponse } | null = null;

async function collect(): Promise<DataQualityResponse> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const now = new Date();
  if (!conn) {
    return {
      now: now.toISOString(),
      totals: { soldComps: 0, flaggedWrong: 0, flaggedWrongPct: 0, excludedFromFmv: 0, priceOutlier: 0, malformedSlugs: 0, unlinkedToTree: 0 },
      flagsByReason: [],
      perSource: [],
    };
  }
  const c = new CosmosClient(conn);
  const sc = c.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");

  const one = async (query: string): Promise<number> => {
    const { resources } = await sc.items.query<number>({ query }).fetchAll();
    return Number(resources[0] ?? 0);
  };

  const [total, flaggedWrong, excludedFromFmv, priceOutlier, malformedSlugs, unlinkedToTree] = await Promise.all([
    one("SELECT VALUE COUNT(1) FROM c"),
    one("SELECT VALUE COUNT(1) FROM c WHERE c.flaggedWrong = true"),
    one("SELECT VALUE COUNT(1) FROM c WHERE c.excludedFromFmv = true"),
    one("SELECT VALUE COUNT(1) FROM c WHERE c.__priceOutlier = true"),
    one(`SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(c.hobbyiqCardId, "::")`),
    one("SELECT VALUE COUNT(1) FROM c WHERE NOT IS_DEFINED(c.cardTreeId)"),
  ]);

  // Group flag reasons — grouped in-memory to avoid the Cosmos GROUP-BY+ORDER-BY-agg limitation
  const { resources: reasonRows } = await sc.items.query<{ r: string | null; n: number; sample: string | null }>({
    query: `SELECT c.flaggedReason AS r, COUNT(1) AS n, MAX(c.hobbyiqCardId) AS sample
            FROM c WHERE c.flaggedWrong = true
            GROUP BY c.flaggedReason`,
  }).fetchAll();
  const flagsByReason: FlagStat[] = reasonRows
    .map((r) => ({ reason: r.r ?? "(unspecified)", count: Number(r.n ?? 0), sample: r.sample }))
    .sort((a, b) => b.count - a.count);

  // Per-source flag rate
  const { resources: sourceRows } = await sc.items.query<{ s: string; total: number; flagged: number }>({
    query: `SELECT c.source AS s, COUNT(1) AS total, SUM(c.flaggedWrong = true ? 1 : 0) AS flagged FROM c GROUP BY c.source`,
  }).fetchAll();
  const perSource = sourceRows
    .filter((r) => r.s)
    .map((r) => ({
      source: r.s,
      total: Number(r.total ?? 0),
      flagged: Number(r.flagged ?? 0),
      flaggedPct: r.total ? Math.round((Number(r.flagged ?? 0) / Number(r.total)) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    now: now.toISOString(),
    totals: {
      soldComps: total,
      flaggedWrong,
      flaggedWrongPct: total ? Math.round((flaggedWrong / total) * 10000) / 100 : 0,
      excludedFromFmv,
      priceOutlier,
      malformedSlugs,
      unlinkedToTree,
    },
    flagsByReason,
    perSource,
  };
}

router.get("/data-quality", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    res.set("Cache-Control", "public, max-age=300");
    res.json(cached.payload);
    return;
  }
  try {
    const payload = await collect();
    cached = { at: now, payload };
    res.set("Cache-Control", "public, max-age=300");
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message ?? String(err) });
  }
});

export default router;
