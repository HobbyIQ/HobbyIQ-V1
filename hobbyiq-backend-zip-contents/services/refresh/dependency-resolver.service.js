"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependencyResolverService = void 0;
class DependencyResolverService {
    async resolveFromEvent(event) {
        const cardKeys = new Set();
        const playerIds = new Set();
        if (event.cardKey)
            cardKeys.add(event.cardKey);
        if (event.playerId)
            playerIds.add(event.playerId);
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
exports.DependencyResolverService = DependencyResolverService;
