"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserById = getUserById;
const MOCK_USERS = {
    "mock-user": {
        id: "mock-user",
        plan: "Prospect",
        features: ["basicAlerts"],
        planLimits: { maxInAppAlerts: 5, premiumSignals: false },
    },
    "premium-user": {
        id: "premium-user",
        plan: "Dealer Pro",
        features: ["basicAlerts", "advancedAlerts", "premiumSignals"],
        planLimits: { maxInAppAlerts: null, premiumSignals: true },
    },
    "allstar-user": {
        id: "allstar-user",
        plan: "All-Star",
        features: ["basicAlerts", "advancedAlerts"],
        planLimits: { maxInAppAlerts: null, premiumSignals: false },
    },
};
function getUserById(id) {
    return MOCK_USERS[id];
}
