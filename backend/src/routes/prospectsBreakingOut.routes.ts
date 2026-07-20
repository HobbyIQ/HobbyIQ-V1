// CF-PROSPECTS-BREAKING-OUT (Drew, 2026-07-20). User-facing feed of
// prospects whose raw prices have inverted against their graded
// medians — a classic breakout signal. Powers the iOS "Prospects"
// tab in DailyIQ. Reuses computeSubRawInversions from the nightly
// scan service so scan telemetry and this endpoint stay coherent.
//
// Route: GET /api/dailyiq/prospects/breaking-out
// Auth:  requireSession
//
// Query params:
//   sport         "baseball" | "football" | "basketball" (default baseball)
//   window        7 | 14 | 30 | 60 (days, default 30)
//   minMargin     minimum inversion % (default 5)
//   limit         max rows (default 20, cap 100)
//
// Response:
//   { sport, windowDays, computedAt, count, prospects: [{ ...SubRawInversion, rank }] }
//
// Ranking: by marginUSD descending (biggest absolute uplift first).

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { computeSubRawInversions } from "../services/signals/subRawInversionScan.service.js";

const router = Router();

router.get("/prospects/breaking-out", requireSession, async (req: Request, res: Response, next) => {
  try {
    const sport = typeof req.query.sport === "string" && req.query.sport.trim().length > 0
      ? req.query.sport.trim().toLowerCase()
      : "baseball";
    const windowRaw = typeof req.query.window === "string" ? Number(req.query.window) : NaN;
    const windowDays = [7, 14, 30, 60].includes(windowRaw) ? windowRaw : 30;
    const minMarginRaw = typeof req.query.minMargin === "string" ? Number(req.query.minMargin) : NaN;
    const minMarginPct = Number.isFinite(minMarginRaw) && minMarginRaw > 0 ? minMarginRaw : 5;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : 20;

    const inversions = await computeSubRawInversions({
      sport,
      windowDays,
      minMarginPct,
    });

    // Rank by absolute-dollar uplift (bigger $ delta = stronger buy signal).
    const ranked = inversions
      .sort((a, b) => b.marginUSD - a.marginUSD)
      .slice(0, limit)
      .map((inv, i) => ({ ...inv, rank: i + 1 }));

    res.json({
      sport,
      windowDays,
      computedAt: new Date().toISOString(),
      count: ranked.length,
      totalDetected: inversions.length,
      prospects: ranked,
    });
  } catch (err) { next(err); }
});

export default router;
