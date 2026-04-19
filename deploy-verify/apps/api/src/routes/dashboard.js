"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dashboard_1 = require("../services/dashboard");
const router = (0, express_1.Router)();
// GET /api/dashboard
router.get("/dashboard", (_req, res) => {
    // In production, use userId from auth/session
    const dashboard = (0, dashboard_1.getDashboard)("demo");
    res.json({ dashboard });
});
exports.default = router;
