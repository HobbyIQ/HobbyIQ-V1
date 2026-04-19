"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const service_1 = require("../alerts/service");
const router = (0, express_1.Router)();
// GET /api/alerts
router.get("/", async (req, res) => {
    // TEMP: single-user assumption
    const userId = req.query.userId || "user-uuid";
    const result = await (0, service_1.getAlerts)(userId);
    res.json(result);
});
// POST /api/alerts
router.post("/", async (req, res) => {
    // Endpoint not implemented: createAlert
    res.status(501).json({ error: "Not implemented" });
});
// POST /api/alerts/:id/read
router.post("/:id/read", async (req, res) => {
    const { id } = req.params;
    const alertId = Array.isArray(id) ? id[0] : id;
    const result = await (0, service_1.markAlertRead)(alertId);
    res.json(result);
});
// POST /api/alerts/:id/dismiss
router.post("/:id/dismiss", async (req, res) => {
    const { id } = req.params;
    const alertId = Array.isArray(id) ? id[0] : id;
    const result = await (0, service_1.dismissAlert)(alertId);
    res.json(result);
});
// POST /api/alerts/evaluate
router.post("/evaluate", async (req, res) => {
    // Endpoint not implemented: evaluateAlertsForPortfolio
    res.status(501).json({ error: "Not implemented" });
});
exports.default = router;
