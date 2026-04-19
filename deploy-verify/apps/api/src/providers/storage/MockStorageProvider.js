"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockStorageProvider = void 0;
const mockStore = {};
class MockStorageProvider {
    getProviderMode() { return "mock"; }
    async save(key, value) {
        mockStore[key] = value;
    }
    async load(key) {
        return mockStore[key] ?? null;
    }
}
exports.MockStorageProvider = MockStorageProvider;
