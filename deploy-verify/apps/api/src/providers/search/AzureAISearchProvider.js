"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureAISearchProvider = void 0;
class AzureAISearchProvider {
    // TODO: Wire up Azure Cognitive Search SDK client here for production
    // import { SearchClient } from "@azure/search-documents"; // Example
    // const client = new SearchClient(...)
    getProviderMode() { return "azure"; }
    async search(query) {
        // TODO: Integrate with Azure AI Search SDK
        // Example: Use Azure Cognitive Search REST API or SDK
        return [{ id: "azure", result: `Azure AI Search result for ${query}` }];
    }
}
exports.AzureAISearchProvider = AzureAISearchProvider;
