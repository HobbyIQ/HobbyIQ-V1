// src/providers/search/AzureSearchProvider.ts
import type { SearchProvider } from "./SearchProvider";

export class AzureSearchProvider implements SearchProvider {
  getProviderMode() { return "azure"; }
  async search(query: string) {
    // TODO: Integrate with Azure Cognitive Search
    return [{ id: "azure", result: `Azure search result for ${query}` }];
  }
}
