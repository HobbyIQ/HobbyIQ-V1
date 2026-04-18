// src/providers/search/MockSearchProvider.ts
import type { SearchProvider } from "./SearchProvider";

export class MockSearchProvider implements SearchProvider {
  getProviderMode() { return "mock"; }
  async search(query: string) {
    return [{ id: "mock", result: `Mock search result for ${query}` }];
  }
}
