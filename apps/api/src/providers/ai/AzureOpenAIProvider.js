"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureOpenAIProvider = void 0;
const env_1 = require("../../config/env");
class AzureOpenAIProvider {
    // TODO: Wire up Azure OpenAI SDK client here for production
    // import { OpenAIClient } from "@azure/openai"; // Example
    // const client = new OpenAIClient(...)
    getProviderMode() { return "azure"; }
    getPromptVersion() { return "v1.0.0-azure"; }
    async generateRationale(input) {
        if (!env_1.env.AZURE_OPENAI_API_KEY)
            return "[Azure OpenAI not configured]";
        // TODO: Integrate with Azure OpenAI SDK
        return `Azure rationale for ${input?.cardId || "unknown card"}`;
    }
    async generateMarketSummary(input) {
        if (!env_1.env.AZURE_OPENAI_API_KEY)
            return "[Azure OpenAI not configured]";
        // TODO: Integrate with Azure OpenAI SDK
        return `Azure market summary for ${input?.segment || "unknown segment"}`;
    }
    async generateAlertExplanation(input) {
        if (!env_1.env.AZURE_OPENAI_API_KEY)
            return "[Azure OpenAI not configured]";
        // TODO: Integrate with Azure OpenAI SDK
        return `Azure alert explanation for ${input?.alertId || "unknown alert"}`;
    }
}
exports.AzureOpenAIProvider = AzureOpenAIProvider;
