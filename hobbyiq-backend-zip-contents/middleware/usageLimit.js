"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackUsage = trackUsage;
exports.getUsage = getUsage;
const service_1 = require("../services/auth/service");
const service_2 = require("../services/subscription/service");
// In-memory usage tracking (replace with DB in prod)
const usage = {};
function trackUsage(type) {
    return async (req, res, next) => {
        const userId = req.userId;
        if (!userId)
            return res.status(401).json({ success: false, error: "Not authenticated" });
        if (!usage[userId])
            usage[userId] = { compiq: 0, playeriq: 0, dailyiq: 0, holdings: 0 };
        usage[userId][type]++;
        const user = await (0, service_1.getUserById)(userId);
        if (!user)
            return res.status(401).json({ success: false, error: "User not found" });
        const plan = (0, service_2.getPlan)(user.plan);
        const limit = plan.limits;
        // Map type to correct PlanLimits property
        const limitKey = type === "compiq"
            ? "compiqSearches"
            : type === "playeriq"
                ? "playeriqEvaluations"
                : type === "dailyiq"
                    ? "dailyiqBriefs"
                    : "holdings";
        if (usage[userId][type] > limit[limitKey]) {
            return res.status(429).json({ success: false, error: `Usage limit reached for ${type}` });
        }
        next();
    };
}
function getUsage(userId) {
    return usage[userId] || { compiq: 0, playeriq: 0, dailyiq: 0, holdings: 0 };
}
