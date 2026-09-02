// CF-MARKET-INDEXES (Drew, 2026-09-02).
//
// Route: GET /api/compiq/market-indexes
// Auth:  requireSession (matches the other compiq market surfaces)
//
// Query params:
//   days   30..180 (default 180) — series window the tiles render
//
// Response:
//   {
//     success, computedAt, windowDays,
//     indexes: [
//       { sport, series: [{ date, level }], latestLevel, changePct,
//         windowDays, basketSize, asOf }
//     ]
//   }
//
// One call returns every sport so the tile strip renders without a
// fan-out. Sports with no points yet come back with an empty series
// rather than being omitted, so the UI can hold a stable tile order.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { getMarketIndexes } from "../services/insights/marketIndexRead.service.js";
import { SERIES_DAYS } from "../services/insights/marketIndex.service.js";

const router = Router();

router.get("/market-indexes", requireSession, async (req: Request, res: Response, next) => {
  try {
    const raw = Number(req.query.days);
    const days = Number.isFinite(raw) ? Math.min(SERIES_DAYS, Math.max(30, Math.round(raw))) : SERIES_DAYS;
    res.json(await getMarketIndexes(days));
  } catch (err) { next(err); }
});

export default router;
