"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLANS = void 0;
exports.getPlan = getPlan;
exports.PLANS = {
    free: {
        name: "free",
        label: "Free",
        description: "Starter access with limited usage and portfolio.",
        limits: {
            compiqSearches: 10,
            playeriqEvaluations: 5,
            dailyiqBriefs: 3,
            holdings: 5,
        },
        features: ["CompIQ (limited)", "PlayerIQ (limited)", "PortfolioIQ Lite (small)", "DailyIQ (limited)"]
    },
    pro: {
        name: "pro",
        label: "Pro",
        description: "Expanded access for active collectors.",
        limits: {
            compiqSearches: 100,
            playeriqEvaluations: 50,
            dailyiqBriefs: 30,
            holdings: 50,
        },
        features: ["CompIQ (expanded)", "PlayerIQ (expanded)", "PortfolioIQ Lite (large)", "DailyIQ (pro)"]
    },
    "all-star": {
        name: "all-star",
        label: "All-Star",
        description: "Full access to all HobbyIQ features and highest limits.",
        limits: {
            compiqSearches: 1000,
            playeriqEvaluations: 500,
            dailyiqBriefs: 100,
            holdings: 500,
        },
        features: ["CompIQ (full)", "PlayerIQ (full)", "PortfolioIQ Lite (max)", "DailyIQ (premium)"]
    }
};
function getPlan(plan) {
    return exports.PLANS[plan];
}
