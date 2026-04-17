"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockMonitoringProvider = void 0;
class MockMonitoringProvider {
    getProviderMode() { return "mock"; }
    async logEvent(event, data) {
        // No-op for mock
    }
    async reportHealth(status, details) {
        // No-op for mock
    }
}
exports.MockMonitoringProvider = MockMonitoringProvider;
