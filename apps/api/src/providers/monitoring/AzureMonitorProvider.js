"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureMonitorProvider = void 0;
class AzureMonitorProvider {
    getProviderMode() { return "azure"; }
    async logEvent(event, data) {
        // TODO: Integrate with Azure Monitor
    }
    async reportHealth(status, details) {
        // TODO: Integrate with Azure Monitor
    }
}
exports.AzureMonitorProvider = AzureMonitorProvider;
