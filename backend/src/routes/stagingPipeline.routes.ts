// CF-STAGING-PIPELINE-ROUTES (Drew, 2026-07-28).
//
// Admin-gated triggers for the three staging pipeline jobs. Meant
// for both nightly cron and on-demand manual runs during rollout.
//
//   POST /api/staging/data-clean?limit=100    → runDataCleanBatch
//   POST /api/staging/image-verify?limit=25   → runImageVerifyBatch
//   POST /api/staging/promotion?limit=100     → runPromotionBatch
//   POST /api/staging/full-cycle?limit=25     → runs all 3 in order
//   GET  /api/staging/health                  → live counts by status

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { runDataCleanBatch } from "../services/portfolioiq/dataCleanJob.service.js";
import { runImageVerifyBatch } from "../services/portfolioiq/imageVerifyJob.service.js";
import { runPromotionBatch } from "../services/portfolioiq/promotionJob.service.js";
import { CosmosClient } from "@azure/cosmos";

const router = Router();
router.use(requireAdmin);

function parseLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === "string" ? Number(raw) : def;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

router.post("/staging/data-clean", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 100, 500);
    const result = await runDataCleanBatch({ limit });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/image-verify", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 25, 200);
    const result = await runImageVerifyBatch({ limit });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/promotion", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 100, 500);
    const result = await runPromotionBatch({ limit });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/staging/full-cycle", async (req, res, next) => {
  try {
    const limit = parseLimit(req.query.limit, 25, 200);
    const dc = await runDataCleanBatch({ limit: limit * 4 });
    const iv = await runImageVerifyBatch({ limit });
    const pr = await runPromotionBatch({ limit: limit * 4 });
    res.json({ success: true, dataClean: dc, imageVerify: iv, promotion: pr });
  } catch (err) { next(err); }
});

router.get("/staging/health", async (_req, res, next) => {
  try {
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return res.json({ success: true, counts: {}, note: "cosmos not configured" });
    const client = new CosmosClient(conn);
    const staging = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container(process.env.COSMOS_COMPS_STAGING_CONTAINER ?? "comps_staging");
    const statuses = ["pending", "clean", "anomaly", "verified", "pending-manual", "promoted"] as const;
    const counts: Record<string, number> = {};
    await Promise.all(statuses.map(async (s) => {
      const { resources } = await staging.items.query<number>({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.status = @s",
        parameters: [{ name: "@s", value: s }],
      }).fetchAll();
      counts[s] = resources[0] ?? 0;
    }));
    const { resources: total } = await staging.items.query<number>("SELECT VALUE COUNT(1) FROM c").fetchAll();
    res.json({ success: true, total: total[0] ?? 0, counts });
  } catch (err) { next(err); }
});

export default router;
