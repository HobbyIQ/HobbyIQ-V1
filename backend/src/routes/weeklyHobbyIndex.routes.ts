// CF-WEEKLY-HOBBY-INDEX (Drew, 2026-07-20). Endpoint:
//   GET /api/insights/weekly-hobby-index?sport=baseball
//   Auth: requireSession
// Returns HobbyIndexResult — WoW aggregation for the sport.

import { Router, type Request, type Response } from "express";
import { requireSession } from "../middleware/requireSession.js";
import { buildWeeklyHobbyIndex } from "../services/insights/weeklyHobbyIndex.service.js";

const router = Router();

router.get("/weekly-hobby-index", requireSession, async (req: Request, res: Response, next) => {
  try {
    const sport = typeof req.query.sport === "string" && req.query.sport.trim().length > 0
      ? req.query.sport.trim().toLowerCase()
      : "baseball";
    const result = await buildWeeklyHobbyIndex(sport);
    if (!result) {
      res.status(503).json({ error: "sold_comps container unavailable" });
      return;
    }
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
