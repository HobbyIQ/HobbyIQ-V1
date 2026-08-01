// CF-QUARANTINE-ROUTES (Drew, 2026-08-01). Admin quarantine surface.
// List flagged rows (any / by-flag-type), mark rows clean, or force-
// quarantine.

import { Router, type Request, type Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { listQuarantined, markRowClean, markRowQuarantined } from "../services/portfolioiq/quarantineView.service.js";

const router = Router();
router.use(requireAdmin);

router.get("/quarantine/list", async (req: Request, res: Response, next) => {
  try {
    const filter = (req.query.filter as "any" | "price-outlier" | "cardsight-unverified" | "user-flagged" | "bad-actor") ?? "any";
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const result = await listQuarantined({ filter, limit });
    if (!result) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.post("/quarantine/:cardId/:rowId/clear", async (req, res, next) => {
  try {
    const out = await markRowClean(req.params.cardId, req.params.rowId);
    res.json(out);
  } catch (err) { next(err); }
});

router.post("/quarantine/:cardId/:rowId/quarantine", async (req, res, next) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "admin forced";
    const out = await markRowQuarantined(req.params.cardId, req.params.rowId, reason);
    res.json(out);
  } catch (err) { next(err); }
});

export default router;
