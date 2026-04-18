"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUnlockedFeatures = getUnlockedFeatures;
const plans_1 = require("../constants/plans");
// Returns all unlocked features for a given plan
function getUnlockedFeatures(plan) {
    const def = plans_1.PLAN_DEFINITIONS.find(p => p.plan === plan);
    return (def?.features || []);
}
