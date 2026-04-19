"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireFeature = requireFeature;
function requireFeature(feature) {
    return (req, res, next) => {
        const user = req.user;
        if (!user) {
            return res.status(401).json({
                success: false,
                error: {
                    code: "UNAUTHORIZED",
                    message: "User not authenticated."
                }
            });
        }
        if (!user.features || !user.features.includes(feature)) {
            // Find the lowest plan that unlocks this feature
            const { PLAN_DEFINITIONS } = require("../constants/plans");
            const unlockPlan = PLAN_DEFINITIONS.find((p) => p.features.includes(feature));
            return res.status(403).json({
                success: false,
                error: {
                    code: "FEATURE_LOCKED",
                    message: `This feature requires a higher plan.`,
                    requiredPlan: unlockPlan?.plan || "Prospect",
                    feature,
                },
                meta: {
                    upgradeUrl: "/plans",
                    plans: PLAN_DEFINITIONS,
                }
            });
        }
        next();
    };
}
