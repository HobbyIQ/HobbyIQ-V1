// CF-OPS-POOL-HEALTH (Drew, 2026-07-20). One admin endpoint that
// returns pool state at-a-glance for the daily 5AM refresh sanity
// check. Row counts by container + sport-tag coverage % + emit-
// failure counter + backfill freshness (max soldAt lag) + retag
// candidate depth.
//
// Route: GET /api/portfolio/admin/pool-health
// Auth: requireAdmin
//
// Reads only. Uses cheap COUNT/MAX aggregations.

import { Router, type Request, type Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { CosmosClient } from "@azure/cosmos";
import { getEmitFailureCount } from "../services/portfolioiq/soldCompsStore.service.js";

const router = Router();

async function q(container: import("@azure/cosmos").Container, query: string): Promise<unknown[]> {
  const { resources } = await container.items.query(query).fetchAll();
  return resources;
}

router.get("/pool-health", requireAdmin, async (_req: Request, res: Response, next) => {
  try {
    const cs = process.env.COSMOS_CONNECTION_STRING;
    if (!cs) { res.status(503).json({ error: "COSMOS_CONNECTION_STRING not set" }); return; }
    const client = new CosmosClient(cs);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const sc = db.container("sold_comps");
    const chDaily = db.container("ch_daily_sales");

    // Sold comps by sport
    const [total, bySport, byGrader, latestSoldAt, latestObservedAt] = await Promise.all([
      q(sc, "SELECT VALUE COUNT(1) FROM c"),
      q(sc, "SELECT c.sport, COUNT(1) AS n FROM c GROUP BY c.sport"),
      q(sc, "SELECT c.gradeCompany, COUNT(1) AS n FROM c GROUP BY c.gradeCompany"),
      q(sc, "SELECT VALUE MAX(c.soldAt) FROM c"),
      q(sc, "SELECT VALUE MAX(c.observedAt) FROM c"),
    ]);

    const [chTotal, chLatest] = await Promise.all([
      q(chDaily, "SELECT VALUE COUNT(1) FROM c"),
      q(chDaily, "SELECT VALUE MAX(c.sale_date) FROM c"),
    ]);

    // Sport coverage %
    const soldCompsTotal = Number(total[0] ?? 0);
    const sportBreakdown: Record<string, number> = {};
    let sportTagged = 0;
    for (const r of bySport as Array<{ sport: string | null; n: number }>) {
      const key = r.sport ?? "(null)";
      sportBreakdown[key] = r.n;
      if (r.sport !== null && r.sport !== undefined) sportTagged += r.n;
    }
    const sportCoveragePct = soldCompsTotal > 0
      ? Math.round((sportTagged / soldCompsTotal) * 1000) / 10
      : 0;

    // Grader coverage
    const graderBreakdown: Record<string, number> = {};
    let graderTagged = 0;
    for (const r of byGrader as Array<{ gradeCompany: string | null; n: number }>) {
      const key = r.gradeCompany ?? "raw";
      graderBreakdown[key] = r.n;
      if (r.gradeCompany !== null && r.gradeCompany !== undefined) graderTagged += r.n;
    }
    const graderCoveragePct = soldCompsTotal > 0
      ? Math.round((graderTagged / soldCompsTotal) * 1000) / 10
      : 0;

    // Freshness: max soldAt vs now
    const nowMs = Date.now();
    const maxSoldAt = String(latestSoldAt[0] ?? "");
    const soldAtLagHours = maxSoldAt
      ? Math.round((nowMs - Date.parse(maxSoldAt)) / 3_600_000)
      : null;
    const maxObservedAt = String(latestObservedAt[0] ?? "");
    const observedAtLagMinutes = maxObservedAt
      ? Math.round((nowMs - Date.parse(maxObservedAt)) / 60_000)
      : null;

    // Retag candidate depth (rows still null-graded but CH-sourced)
    const [retagCandidates] = await Promise.all([
      q(sc, "SELECT VALUE COUNT(1) FROM c WHERE c.source = 'cardhedge' AND c.gradeCompany = null AND c.gradeValue = null"),
    ]);

    res.json({
      computedAt: new Date().toISOString(),
      sold_comps: {
        totalRows: soldCompsTotal,
        sportBreakdown,
        sportCoveragePct,
        graderBreakdown,
        graderCoveragePct,
        latestSoldAt: maxSoldAt || null,
        soldAtLagHours,
        latestObservedAt: maxObservedAt || null,
        observedAtLagMinutes,
        retagCandidatesRemaining: Number(retagCandidates[0] ?? 0),
      },
      ch_daily_sales: {
        totalRows: Number(chTotal[0] ?? 0),
        latestSaleDate: String(chLatest[0] ?? "") || null,
      },
      runtime: {
        emitFailureCounterLifetime: getEmitFailureCount(),
      },
    });
  } catch (err) { next(err); }
});

export default router;
