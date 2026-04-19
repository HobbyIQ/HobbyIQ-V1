"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureSearchProvider = void 0;
class AzureSearchProvider {
    getProviderMode() { return "azure"; }
    async search(query) {
        // TODO: Integrate with Azure Cognitive Search
        return [{ id: "azure", result: `Azure search result for ${query}` }];
    }
}
exports.AzureSearchProvider = AzureSearchProvider;
