"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealPlayerPerformanceProvider = void 0;
class RealPlayerPerformanceProvider {
    async getPerformance(playerId) {
        // TODO: Integrate with real player performance API
        throw new Error("RealPlayerPerformanceProvider not implemented");
    }
    async health() {
        // TODO: Implement real health check (e.g., test player performance API credentials)
        return { status: "unhealthy", details: "Not implemented" };
    }
}
exports.RealPlayerPerformanceProvider = RealPlayerPerformanceProvider;
