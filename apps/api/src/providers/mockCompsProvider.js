"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockCompsProvider = void 0;
class MockCompsProvider {
    async getComps(query) {
        // Return mock comps
        return [
            { cardId: "1", price: 100, date: new Date().toISOString(), source: "mock" },
            { cardId: "2", price: 150, date: new Date().toISOString(), source: "mock" }
        ];
    }
    async health() {
        return { status: "ok", details: "Mock provider always healthy" };
    }
}
exports.MockCompsProvider = MockCompsProvider;
