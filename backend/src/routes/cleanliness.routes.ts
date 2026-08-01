// CF-CLEANLINESS-ROUTES (Drew, 2026-08-01). Admin endpoint that returns
// the cleanliness report. Backs the /app/admin/cleanliness dashboard.

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { computeCleanlinessReport } from "../services/portfolioiq/cleanliness.service.js";

const router = Router();
router.use(requireAdmin);

router.get("/cleanliness/report", async (_req, res, next) => {
  try {
    const report = await computeCleanlinessReport(false);
    if (!report) {
      res.status(503).json({ success: false, error: "Cosmos not configured" });
      return;
    }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

router.post("/cleanliness/refresh", async (_req, res, next) => {
  try {
    const report = await computeCleanlinessReport(true);
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

export default router;
