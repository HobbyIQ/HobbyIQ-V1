// src/routes/learning/learningRoutes.ts
import { Router } from "express";
import { learningService } from "../../services/learning/learningService";
import { ok, notFound } from "../../utils/response";
import { checkLearningReadiness } from "../../config/env";

const router = Router();

router.get("/readiness", (_req, res) => {
  const status = checkLearningReadiness();
  res.json(ok(status));
});

router.get("/comp-observations", async (_req, res) => {
  const data = await learningService.getCompObservations();
  res.json(ok(data));
});

router.get("/pricing-snapshots", async (_req, res) => {
  const data = await learningService.getPricingSnapshots();
  res.json(ok(data));
});

router.get("/pricing-outcomes", async (_req, res) => {
  const data = await learningService.getPricingOutcomes();
  res.json(ok(data));
});

router.get("/model-weight-profiles", async (_req, res) => {
  const data = await learningService.getModelWeightProfiles();
  res.json(ok(data));
});

router.get("/learning-adjustment-logs", async (_req, res) => {
  const data = await learningService.getLearningAdjustmentLogs();
  res.json(ok(data));
});

router.get("/prompt-experiment-runs", async (_req, res) => {
  const data = await learningService.getPromptExperimentRuns();
  res.json(ok(data));
});

router.get("/evaluation-metric-logs", async (_req, res) => {
  const data = await learningService.getEvaluationMetricLogs();
  res.json(ok(data));
});

router.get("/alert-outcome-logs", async (_req, res) => {
  const data = await learningService.getAlertOutcomeLogs();
  res.json(ok(data));
});

router.get("/recommendation-outcomes", async (_req, res) => {
  const data = await learningService.getRecommendationOutcomes();
  res.json(ok(data));
});

export default router;
