import { Request, Response } from "express";
import { QueueService } from "../../services/queues/queue.interface";
import { SnapshotRefreshRequest } from "../../domain/events/snapshot-refresh-request";
import { QUEUE_NAMES } from "../../services/queues/queue-names";
import { randomUUID } from "crypto";

export class RefreshController {
  constructor(private readonly queue: QueueService<SnapshotRefreshRequest>) {}

  manualRefresh = async (req: Request, res: Response): Promise<void> => {
    const { entityType, entityKey, playerId, cardKey } = req.body as {
      entityType: "card" | "player";
      entityKey: string;
      playerId?: string;
      cardKey?: string;
    };

    const payload: SnapshotRefreshRequest = {
      requestId: randomUUID(),
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

    await this.queue.enqueue(
      entityType === "card" ? QUEUE_NAMES.SNAPSHOT_REFRESH_CARD : QUEUE_NAMES.SNAPSHOT_REFRESH_PLAYER,
      payload,
    );

    res.status(202).json({
      success: true,
      refreshQueued: true,
      requestId: payload.requestId,
    });
  };
}
