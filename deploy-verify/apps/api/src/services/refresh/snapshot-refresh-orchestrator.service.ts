import { SnapshotRefreshRequest } from "../../domain/events/snapshot-refresh-request";
import { RefreshDeduperService } from "./refresh-deduper.service";
import { RefreshExecutionService } from "./refresh-execution.service";
import { SnapshotDiffService } from "./snapshot-diff.service";
import { AlertSignalBuilderService } from "./alert-signal-builder.service";

export interface SnapshotStore {
  getLatest(entityType: "card" | "player", entityKey: string): Promise<Record<string, unknown> | null>;
  saveResult(result: Record<string, unknown>): Promise<void>;
}

export interface AlertSignalRepository {
  saveMany(signals: Array<Record<string, unknown>>): Promise<void>;
}

export class SnapshotRefreshOrchestratorService {
  constructor(
    private readonly deduper: RefreshDeduperService,
    private readonly executor: RefreshExecutionService,
    private readonly diffService: SnapshotDiffService,
    private readonly alertBuilder: AlertSignalBuilderService,
    private readonly snapshotStore: SnapshotStore,
    private readonly alertRepository: AlertSignalRepository,
  ) {}

  async handle(request: SnapshotRefreshRequest): Promise<void> {
    const acquired = this.deduper.tryAcquire(request.entityType, request.entityKey);
    if (!acquired) return;

    try {
      const previous = await this.snapshotStore.getLatest(request.entityType, request.entityKey);
      const execution = await this.executor.execute(request);

      await this.snapshotStore.saveResult(execution.result as unknown as Record<string, unknown>);

      if (execution.result.status !== "success" || !execution.snapshotJson) return;

      const diff = this.diffService.diff(previous, execution.snapshotJson);
      const signals = this.alertBuilder.build(request.entityType, request.entityKey, diff.changedFields);

      if (signals.length) {
        await this.alertRepository.saveMany(signals as unknown as Array<Record<string, unknown>>);
      }
    } finally {
      this.deduper.release(request.entityType, request.entityKey);
    }
  }
}
