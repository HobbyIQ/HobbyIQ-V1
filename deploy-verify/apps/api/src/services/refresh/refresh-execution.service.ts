import { SnapshotRefreshRequest } from "../../domain/events/snapshot-refresh-request";
import { SnapshotRefreshResult } from "../../domain/events/snapshot-refresh-result";
import { randomUUID } from "crypto";

export interface CardSnapshotBuilder {
  build(cardKey: string): Promise<{ snapshotId: string; snapshotJson: Record<string, unknown> }>;
}

export interface PlayerSnapshotBuilder {
  build(playerId: string): Promise<{ snapshotId: string; snapshotJson: Record<string, unknown> }>;
}

export class RefreshExecutionService {
  constructor(
    private readonly cardBuilder: CardSnapshotBuilder,
    private readonly playerBuilder: PlayerSnapshotBuilder,
  ) {}

  async execute(request: SnapshotRefreshRequest): Promise<{
    result: SnapshotRefreshResult;
    snapshotJson?: Record<string, unknown>;
  }> {
    const startedAt = new Date().toISOString();

    try {
      if (request.entityType === "card") {
        const built = await this.cardBuilder.build(request.entityKey);

        return {
          result: {
            resultId: randomUUID(),
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
          resultId: randomUUID(),
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
    } catch (error) {
      return {
        result: {
          resultId: randomUUID(),
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
