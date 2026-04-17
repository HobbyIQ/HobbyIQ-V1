"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockAIProvider = void 0;
class MockAIProvider {
    getProviderMode() { return "mock"; }
    getPromptVersion() { return "v1.0.0-mock"; }
    async generateRationale(input) {
        return `Mock rationale for ${input?.cardId || "unknown card"}`;
    }
    async generateMarketSummary(input) {
        return `Mock market summary for ${input?.segment || "unknown segment"}`;
    }
    async generateAlertExplanation(input) {
        return `Mock alert explanation for ${input?.alertId || "unknown alert"}`;
    }
}
exports.MockAIProvider = MockAIProvider;
