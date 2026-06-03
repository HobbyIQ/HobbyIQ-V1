// CF-SCANNING-B5-FIXES (2026-06-03): manual warm endpoint for the
// Cardsight identifiable-set inventory snapshot.
//
//   POST /api/internal/cardsight-inventory/refresh
//
// Admin-token gated (x-admin-token header vs CARDSIGHT_INVENTORY_ADMIN_TOKEN
// env var) — same pattern as /api/dailyiq/admin/run-job.
//
// Use case: after a fresh deploy, the daily refresh job's next fire is at
// 04:30 PT, which could be up to 24h away. This endpoint runs
// runInventoryRefreshJob() once immediately so the snapshot is populated
// without waiting for the cron.
//
// Status codes:
//   200 success           — { success, refreshedAt, totalCount, segmentCounts }
//   401 invalid token     — wrong x-admin-token
//   503 not configured    — CARDSIGHT_INVENTORY_ADMIN_TOKEN env var unset
//   500 refresh failed    — runInventoryRefreshJob threw

import { Router, type Request, type Response } from "express";
import { runInventoryRefreshJob } from "../jobs/cardsightInventoryRefresh.job.js";

const router = Router();

router.post("/refresh", async (req: Request, res: Response) => {
  const expected = process.env.CARDSIGHT_INVENTORY_ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({
      success: false,
      error: "CARDSIGHT_INVENTORY_ADMIN_TOKEN not configured",
    });
    return;
  }
  if (String(req.headers["x-admin-token"] ?? "") !== expected) {
    res.status(401).json({ success: false, error: "Invalid admin token" });
    return;
  }

  try {
    const result = await runInventoryRefreshJob();
    res.json({
      success: true,
      refreshedAt: result.refreshedAt,
      totalCount: result.totalCount,
      segmentCounts: result.segmentCounts,
      pagesFetched: result.pagesFetched,
      durationMs: result.durationMs,
    });
  } catch (err: unknown) {
    console.error("[internal/cardsight-inventory/refresh] failed:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Refresh failed",
    });
  }
});

export default router;
