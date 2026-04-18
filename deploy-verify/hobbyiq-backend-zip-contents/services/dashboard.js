"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboard = getDashboard;
// Mock dashboard service for HobbyIQ
function getDashboard(userId) {
    // Return mock dashboard data
    return {
        userId,
        stats: {
            cards: 10,
            alerts: 2,
            plan: "Dealer Pro"
        }
    };
}
