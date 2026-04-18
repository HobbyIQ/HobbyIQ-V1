"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshController = void 0;
const queue_names_1 = require("../../services/queues/queue-names");
const crypto_1 = require("crypto");
class RefreshController {
    constructor(queue) {
        this.queue = queue;
        this.manualRefresh = async (req, res) => {
            const { entityType, entityKey, playerId, cardKey } = req.body;
            const payload = {
                requestId: (0, crypto_1.randomUUID)(),
                entityType,
                entityKey,
                playerId,
                cardKey,
                reasonCodes: ["manual_refresh_requested"],
                requestedAt: new Date().toISOString(),
                priority: "high",
                forceRefresh: true,
                requestedBy: "user",
            };
            await this.queue.enqueue(entityType === "card" ? queue_names_1.QUEUE_NAMES.SNAPSHOT_REFRESH_CARD : queue_names_1.QUEUE_NAMES.SNAPSHOT_REFRESH_PLAYER, payload);
            res.status(202).json({
                success: true,
                refreshQueued: true,
                requestId: payload.requestId,
            });
        };
    }
}
exports.RefreshController = RefreshController;
