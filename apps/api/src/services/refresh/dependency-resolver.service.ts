import { MarketDataEvent } from "../../domain/events/market-data-event";

export interface DependencyImpact {
  cardKeys: string[];
  playerIds: string[];
}

export class DependencyResolverService {
  async resolveFromEvent(event: MarketDataEvent): Promise<DependencyImpact> {
    const cardKeys = new Set<string>();
    const playerIds = new Set<string>();

    if (event.cardKey) cardKeys.add(event.cardKey);
    if (event.playerId) playerIds.add(event.playerId);

    if (event.entityType === "card" && event.entityKey) {
      cardKeys.add(event.entityKey);
    }

    if (event.entityType === "player" && event.entityKey) {
      playerIds.add(event.entityKey);
    }

    return {
      cardKeys: Array.from(cardKeys),
      playerIds: Array.from(playerIds),
    };
  }
}
