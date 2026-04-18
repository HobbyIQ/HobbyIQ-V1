"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const plan_1 = require("../services/plan");
const router = (0, express_1.Router)();
// GET /api/plans
router.get("/plans", (_req, res) => {
    const plans = (0, plan_1.getPlans)();
    res.json({ plans });
});
exports.default = router;
