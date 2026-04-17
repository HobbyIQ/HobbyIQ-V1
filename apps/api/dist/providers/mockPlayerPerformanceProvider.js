"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockPlayerPerformanceProvider = void 0;
class MockPlayerPerformanceProvider {
    async getPerformance(playerId) {
        // Return mock player performance
        return {
            playerId,
            stats: { points: Math.floor(Math.random() * 30), assists: Math.floor(Math.random() * 10) },
            notes: "Mock player performance."
        };
    }
    async health() {
        return { status: "ok", details: "Mock provider always healthy" };
    }
}
exports.MockPlayerPerformanceProvider = MockPlayerPerformanceProvider;
