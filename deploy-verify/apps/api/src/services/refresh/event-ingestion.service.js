"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventIngestionService = void 0;
const crypto_1 = require("crypto");
const queue_names_1 = require("../queues/queue-names");
class EventIngestionService {
    constructor(repository, changeDetection, dependencyResolver, queue) {
        this.repository = repository;
        this.changeDetection = changeDetection;
        this.dependencyResolver = dependencyResolver;
        this.queue = queue;
    }
    async ingest(event) {
        if (event.dedupeKey && (await this.repository.existsByDedupeKey(event.dedupeKey))) {
            return { accepted: false, refreshRequests: 0 };
        }
        await this.repository.save(event);
        const impact = await this.dependencyResolver.resolveFromEvent(event);
        let created = 0;
        for (const cardKey of impact.cardKeys) {
            const result = this.changeDetection.evaluate({
                event,
                hasSnapshot: true,
                isExpired: false,
            });
            if (!result.shouldRefresh)
                continue;
            await this.queue.enqueue(queue_names_1.QUEUE_NAMES.SNAPSHOT_REFRESH_CARD, {
                requestId: (0, crypto_1.randomUUID)(),
                entityType: "card",
                entityKey: cardKey,
                cardKey,
                playerId: event.playerId,
                reasonCodes: result.reasonCodes,
                requestedAt: new Date().toISOString(),
                priority: result.priority,
                forceRefresh: false,
                requestedBy: "system",
            });
            created += 1;
        }
        for (const playerId of impact.playerIds) {
            const result = this.changeDetection.evaluate({
                event,
                hasSnapshot: true,
                isExpired: false,
            });
            if (!result.shouldRefresh)
                continue;
            await this.queue.enqueue(queue_names_1.QUEUE_NAMES.SNAPSHOT_REFRESH_PLAYER, {
                requestId: (0, crypto_1.randomUUID)(),
                entityType: "player",
                entityKey: playerId,
                playerId,
                reasonCodes: result.reasonCodes,
                requestedAt: new Date().toISOString(),
                priority: result.priority,
                forceRefresh: false,
                requestedBy: "system",
            });
            created += 1;
        }
        return { accepted: true, refreshRequests: created };
    }
}
exports.EventIngestionService = EventIngestionService;
