"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshExecutionService = void 0;
const crypto_1 = require("crypto");
class RefreshExecutionService {
    constructor(cardBuilder, playerBuilder) {
        this.cardBuilder = cardBuilder;
        this.playerBuilder = playerBuilder;
    }
    async execute(request) {
        const startedAt = new Date().toISOString();
        try {
            if (request.entityType === "card") {
                const built = await this.cardBuilder.build(request.entityKey);
                return {
                    result: {
                        resultId: (0, crypto_1.randomUUID)(),
                        requestId: request.requestId,
                        entityType: "card",
                        entityKey: request.entityKey,
                        startedAt,
                        completedAt: new Date().toISOString(),
                        status: "success",
                        refreshPath: "silver_rebuild",
                        snapshotId: built.snapshotId,
                    },
                    snapshotJson: built.snapshotJson,
                };
            }
            const built = await this.playerBuilder.build(request.entityKey);
            return {
                result: {
                    resultId: (0, crypto_1.randomUUID)(),
                    requestId: request.requestId,
                    entityType: "player",
                    entityKey: request.entityKey,
                    startedAt,
                    completedAt: new Date().toISOString(),
                    status: "success",
                    refreshPath: "silver_rebuild",
                    snapshotId: built.snapshotId,
                },
                snapshotJson: built.snapshotJson,
            };
        }
        catch (error) {
            return {
                result: {
                    resultId: (0, crypto_1.randomUUID)(),
                    requestId: request.requestId,
                    entityType: request.entityType,
                    entityKey: request.entityKey,
                    startedAt,
                    completedAt: new Date().toISOString(),
                    status: "failed",
                    refreshPath: "silver_rebuild",
                    errorMessage: error instanceof Error ? error.message : "Unknown refresh error",
                },
            };
        }
    }
}
exports.RefreshExecutionService = RefreshExecutionService;
