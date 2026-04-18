"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchProviderFactory = searchProviderFactory;
// src/providers/factories/searchProviderFactory.ts
const env_1 = require("../../config/env");
const MockSearchProvider_1 = require("../search/MockSearchProvider");
const AzureAISearchProvider_1 = require("../search/AzureAISearchProvider");
const monitoringProviderFactory_1 = require("./monitoringProviderFactory");
function searchProviderFactory() {
    const monitoring = (0, monitoringProviderFactory_1.monitoringProviderFactory)();
    let provider;
    if (env_1.env.AI_MODE === "azure" && env_1.env.AZURE_AI_SEARCH_API_KEY && env_1.env.AZURE_AI_SEARCH_ENDPOINT) {
        provider = new AzureAISearchProvider_1.AzureAISearchProvider();
    }
    else {
        provider = new MockSearchProvider_1.MockSearchProvider();
    }
    // Beta: suppress search provider init log
    monitoring.logEvent?.("SearchProviderInitialized", { mode: provider.getProviderMode() });
    return provider;
}
