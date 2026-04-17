"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const subscriptionRepository_1 = require("../repositories/subscriptionRepository");
const featureAccess_1 = require("../utils/featureAccess");
const planTiers_1 = require("../models/planTiers");
const router = express_1.default.Router();
// /api/me/access
router.get("/access", (req, res) => {
    const userId = req.headers["x-user-id"] || req.query.userId || req.body.userId;
    if (!userId)
        return res.status(401).json({ success: false, error: "Missing userId" });
    const plan = (0, subscriptionRepository_1.getUserPlan)(userId);
    const features = (0, featureAccess_1.getUnlockedFeatures)(plan);
    const limits = planTiers_1.PLAN_NOTIFICATION_LIMITS[plan] || {};
    res.json({
        userId,
        plan,
        features,
        limits
    });
});
exports.default = router;
