"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockSearchProvider = void 0;
class MockSearchProvider {
    getProviderMode() { return "mock"; }
    async search(query) {
        return [{ id: "mock", result: `Mock search result for ${query}` }];
    }
}
exports.MockSearchProvider = MockSearchProvider;
