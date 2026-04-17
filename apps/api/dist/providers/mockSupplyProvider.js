"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockSupplyProvider = void 0;
class MockSupplyProvider {
    async getSupply(cardId) {
        // Return mock supply
        return {
            cardId,
            supply: Math.floor(Math.random() * 1000),
            notes: "Mock supply value."
        };
    }
    async health() {
        return { status: "ok", details: "Mock provider always healthy" };
    }
}
exports.MockSupplyProvider = MockSupplyProvider;
