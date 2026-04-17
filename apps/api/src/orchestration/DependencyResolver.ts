// Resolves dependencies for cascading refreshes
export interface DependencyResolver {
  getImpactedEntities(event: MarketDataEvent): Promise<string[]>;
  getPlayerDependencies(cardKey: string): Promise<string[]>;
}
