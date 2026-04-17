import { randomUUID } from "crypto";
import { MarketDataEvent } from "../../domain/events/market-data-event";
import { SnapshotRefreshRequest } from "../../domain/events/snapshot-refresh-request";
import { ChangeDetectionService } from "./change-detection.service";
import { DependencyResolverService } from "./dependency-resolver.service";
import { QueueService } from "../queues/queue.interface";
import { QUEUE_NAMES } from "../queues/queue-names";

export interface MarketEventRepository {
  save(event: MarketDataEvent): Promise<void>;
  existsByDedupeKey(dedupeKey: string): Promise<boolean>;
}

export class EventIngestionService {
  constructor(
    private readonly repository: MarketEventRepository,
    private readonly changeDetection: ChangeDetectionService,
    private readonly dependencyResolver: DependencyResolverService,
    private readonly queue: QueueService<SnapshotRefreshRequest>,
  ) {}

  async ingest(event: MarketDataEvent): Promise<{ accepted: boolean; refreshRequests: number }> {
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

      if (!result.shouldRefresh) continue;

      await this.queue.enqueue(QUEUE_NAMES.snapshotRefreshCard, {
        requestId: randomUUID(),
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

      if (!result.shouldRefresh) continue;

      await this.queue.enqueue(QUEUE_NAMES.snapshotRefreshPlayer, {
        requestId: randomUUID(),
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
