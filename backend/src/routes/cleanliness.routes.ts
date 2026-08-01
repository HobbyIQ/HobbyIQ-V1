// CF-CLEANLINESS-ROUTES (Drew, 2026-08-01). Admin endpoint that returns
// the cleanliness report. Backs the /app/admin/cleanliness dashboard.

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { computeCleanlinessReport } from "../services/portfolioiq/cleanliness.service.js";
import { computeBadActorReport } from "../services/portfolioiq/badActorDetection.service.js";

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

router.get("/cleanliness/bad-actors", async (req, res, next) => {
  try {
    const force = req.query.force === "true";
    const report = await computeBadActorReport(force);
    if (!report) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

router.get("/cleanliness/learning", async (_req, res, next) => {
  try {
    const { summarizeLearning } = await import("../services/portfolioiq/learningEvents.service.js");
    const summary = await summarizeLearning();
    if (!summary) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, summary });
  } catch (err) { next(err); }
});

router.post("/cleanliness/train-weights", async (req, res, next) => {
  try {
    const { trainConfidenceWeights } = await import("../services/portfolioiq/confidenceWeightsLearner.service.js");
    const fromDaysBack = req.query.days ? Number(req.query.days) : 30;
    const learned = await trainConfidenceWeights({ fromDaysBack });
    if (!learned) { res.json({ success: true, message: "not enough training data yet — try again after more human decisions have accumulated" }); return; }
    res.json({ success: true, learned });
  } catch (err) { next(err); }
});

router.get("/cleanliness/current-weights", async (_req, res, next) => {
  try {
    const { loadCurrentWeights } = await import("../services/portfolioiq/confidenceWeightsLearner.service.js");
    const w = await loadCurrentWeights();
    res.json({ success: true, weights: w });
  } catch (err) { next(err); }
});

router.get("/cleanliness/slug-audit", async (req, res, next) => {
  try {
    const { computeSlugAuditReport } = await import("../services/portfolioiq/slugAudit.service.js");
    const force = req.query.force === "true";
    const report = await computeSlugAuditReport(force);
    if (!report) { res.status(503).json({ success: false, error: "Cosmos not configured" }); return; }
    res.json({ success: true, report });
  } catch (err) { next(err); }
});

export default router;
