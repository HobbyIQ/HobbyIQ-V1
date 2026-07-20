// CF-COHORT-BACKTEST (Drew, 2026-07-20). User-facing endpoint for
// "rookie class of 20XX vs 20YY" analytics. Powers narrative surfaces
// AND informs FMV projection by class.
//
// Route: GET /api/compiq/cohort-backtest
// Auth:  requireSession
//
// Query params:
//   sport         "baseball" | "football" | "basketball" (default baseball)
//   cohortYear    integer (default 2020)
//   window        days (default 90)
//   limit         max top-gainers/decliners (default 30)
//
// Response: CohortBacktestResult (see cohortBacktest.service.ts).

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { runCohortBacktest } from "../services/cohort/cohortBacktest.service.js";

const router = Router();

router.get("/cohort-backtest", requireSession, async (req: Request, res: Response, next) => {
  try {
    const sport = typeof req.query.sport === "string" && req.query.sport.trim().length > 0
      ? req.query.sport.trim().toLowerCase()
      : "baseball";
    const yearRaw = typeof req.query.cohortYear === "string" ? Number(req.query.cohortYear) : NaN;
    const cohortYear = Number.isFinite(yearRaw) && yearRaw >= 1980 && yearRaw <= new Date().getUTCFullYear()
      ? Math.floor(yearRaw)
      : 2020;
    const windowRaw = typeof req.query.window === "string" ? Number(req.query.window) : NaN;
    const windowDays = Number.isFinite(windowRaw) && windowRaw >= 7 && windowRaw <= 365 ? Math.floor(windowRaw) : 90;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : 30;

    const result = await runCohortBacktest({ sport, cohortYear, windowDays, limit });
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
