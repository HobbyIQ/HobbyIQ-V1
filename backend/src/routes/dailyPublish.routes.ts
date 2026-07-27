// CF-DAILY-PUBLISH (Drew, 2026-07-27). Public read + admin-token-gated
// write endpoints for the twice-daily editorial snapshot. GH Actions
// workflow calls the publish endpoint at 5AM ET and 5PM ET; every web
// user hits the read endpoint for an instant load.

import { Router, type Request, type Response } from "express";
import {
  readLatestMarketSnapshot,
  publishMarketSnapshot,
} from "../services/dailyPublish/dailyPublish.service.js";

const router = Router();

// GET /api/daily/market-snapshot — public. Returns the latest published
// market snapshot (top gainers/losers + notable sales) with an "As of"
// timestamp so the UI can render a "Published Aug 15 · 5:00 AM ET" line.
router.get("/market-snapshot", async (_req: Request, res: Response) => {
  const snapshot = await readLatestMarketSnapshot();
  if (!snapshot) {
    // Cold state (first publish hasn't run) or Cosmos unreachable — the
    // web client falls back to the live top-movers path.
    return res.status(404).json({ success: false, error: "No snapshot published yet" });
  }
  res.set("Cache-Control", "public, max-age=300");
  res.json({ success: true, snapshot });
});

// POST /api/daily/publish-market — admin-token gated. Called by the
// GH Actions workflow twice daily.
//
// Auth: Authorization: Bearer <DAILY_PUBLISH_ADMIN_TOKEN>. If the
// env var is not set the route returns 503 (safe default — no way to
// call it accidentally).
router.post("/publish-market", async (req: Request, res: Response) => {
  const token = process.env.DAILY_PUBLISH_ADMIN_TOKEN;
  if (!token) {
    return res.status(503).json({ success: false, error: "Publish token not configured" });
  }
  const auth = String(req.headers.authorization ?? "");
  if (auth !== `Bearer ${token}`) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const slotRaw = String(req.body?.slot ?? req.query?.slot ?? "").toLowerCase();
  const slot: "morning" | "evening" = slotRaw === "evening" ? "evening" : "morning";
  try {
    const snapshot = await publishMarketSnapshot(slot);
    if (!snapshot) {
      return res
        .status(500)
        .json({ success: false, error: "Compute produced nothing — DailyIQ brief may be cold" });
    }
    res.json({
      success: true,
      publishedAt: snapshot.publishedAt,
      publishedSlot: snapshot.publishedSlot,
      topGainersCount: snapshot.topGainers.length,
      topLosersCount: snapshot.topLosers.length,
      notableSalesCount: snapshot.notableSales.length,
      poolSize: snapshot.poolSize,
    });
  } catch (err) {
    console.error("[daily/publish-market] failed:", err);
    res
      .status(500)
      .json({ success: false, error: err instanceof Error ? err.message : "Publish failed" });
  }
});

export default router;
