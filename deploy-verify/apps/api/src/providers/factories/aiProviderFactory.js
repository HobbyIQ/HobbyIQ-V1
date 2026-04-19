"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiProviderFactory = aiProviderFactory;
// src/providers/factories/aiProviderFactory.ts
const env_1 = require("../../config/env");
const MockAIProvider_1 = require("../ai/MockAIProvider");
const AzureOpenAIProvider_1 = require("../ai/AzureOpenAIProvider");
const monitoringProviderFactory_1 = require("./monitoringProviderFactory");
function aiProviderFactory() {
    const monitoring = (0, monitoringProviderFactory_1.monitoringProviderFactory)();
    let provider;
    if (env_1.env.AI_MODE === "azure" && env_1.env.AZURE_OPENAI_API_KEY && env_1.env.AZURE_OPENAI_ENDPOINT) {
        provider = new AzureOpenAIProvider_1.AzureOpenAIProvider();
    }
    else {
        provider = new MockAIProvider_1.MockAIProvider();
    }
    // Beta: suppress AI provider init log
    monitoring.logEvent?.("AIProviderInitialized", { mode: provider.getProviderMode() });
    return provider;
}
