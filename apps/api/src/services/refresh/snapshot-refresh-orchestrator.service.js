"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotRefreshOrchestratorService = void 0;
class SnapshotRefreshOrchestratorService {
    constructor(deduper, executor, diffService, alertBuilder, snapshotStore, alertRepository) {
        this.deduper = deduper;
        this.executor = executor;
        this.diffService = diffService;
        this.alertBuilder = alertBuilder;
        this.snapshotStore = snapshotStore;
        this.alertRepository = alertRepository;
    }
    async handle(request) {
        const acquired = this.deduper.tryAcquire(request.entityType, request.entityKey);
        if (!acquired)
            return;
        try {
            const previous = await this.snapshotStore.getLatest(request.entityType, request.entityKey);
            const execution = await this.executor.execute(request);
            await this.snapshotStore.saveResult(execution.result);
            if (execution.result.status !== "success" || !execution.snapshotJson)
                return;
            const diff = this.diffService.diff(previous, execution.snapshotJson);
            const signals = this.alertBuilder.build(request.entityType, request.entityKey, diff.changedFields);
            if (signals.length) {
                await this.alertRepository.saveMany(signals);
            }
        }
        finally {
            this.deduper.release(request.entityType, request.entityKey);
        }
    }
}
exports.SnapshotRefreshOrchestratorService = SnapshotRefreshOrchestratorService;
