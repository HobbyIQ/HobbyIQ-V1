"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntakeReconciliationJob = void 0;
class IntakeReconciliationJob {
    constructor(reconciliationService) {
        this.reconciliationService = reconciliationService;
    }
    async run(userId, importBatchId) {
        // Run reconciliation for a given import batch
        return this.reconciliationService.reconcileBatch(userId, importBatchId);
    }
}
exports.IntakeReconciliationJob = IntakeReconciliationJob;
