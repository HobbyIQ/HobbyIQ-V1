"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/learning/learningRoutes.ts
const express_1 = require("express");
const learningService_1 = require("../../services/learning/learningService");
const response_1 = require("../../utils/response");
const env_1 = require("../../config/env");
const router = (0, express_1.Router)();
router.get("/readiness", (_req, res) => {
    const status = (0, env_1.checkLearningReadiness)();
    res.json((0, response_1.ok)(status));
});
router.get("/comp-observations", async (_req, res) => {
    const data = await learningService_1.learningService.getCompObservations();
    res.json((0, response_1.ok)(data));
});
router.get("/pricing-snapshots", async (_req, res) => {
    const data = await learningService_1.learningService.getPricingSnapshots();
    res.json((0, response_1.ok)(data));
});
router.get("/pricing-outcomes", async (_req, res) => {
    const data = await learningService_1.learningService.getPricingOutcomes();
    res.json((0, response_1.ok)(data));
});
router.get("/model-weight-profiles", async (_req, res) => {
    const data = await learningService_1.learningService.getModelWeightProfiles();
    res.json((0, response_1.ok)(data));
});
router.get("/learning-adjustment-logs", async (_req, res) => {
    const data = await learningService_1.learningService.getLearningAdjustmentLogs();
    res.json((0, response_1.ok)(data));
});
router.get("/prompt-experiment-runs", async (_req, res) => {
    const data = await learningService_1.learningService.getPromptExperimentRuns();
    res.json((0, response_1.ok)(data));
});
router.get("/evaluation-metric-logs", async (_req, res) => {
    const data = await learningService_1.learningService.getEvaluationMetricLogs();
    res.json((0, response_1.ok)(data));
});
router.get("/alert-outcome-logs", async (_req, res) => {
    const data = await learningService_1.learningService.getAlertOutcomeLogs();
    res.json((0, response_1.ok)(data));
});
router.get("/recommendation-outcomes", async (_req, res) => {
    const data = await learningService_1.learningService.getRecommendationOutcomes();
    res.json((0, response_1.ok)(data));
});
exports.default = router;
