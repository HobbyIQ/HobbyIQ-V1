// src/providers/search/SearchProvider.ts
export interface SearchProvider {
  search(query: string): Promise<any[]>;
  getProviderMode(): string;
}
