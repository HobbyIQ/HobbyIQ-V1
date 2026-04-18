"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconciliationService = void 0;
class ReconciliationService {
    constructor(positionRepo) {
        this.positionRepo = positionRepo;
    }
    async matchRow(row) {
        // Example: exact match on entityKey
        const entityKey = row.rawJson.entityKey;
        if (!entityKey)
            return null;
        // TODO: Add provider_link/fuzzy/manual_review logic
        // This is a stub for exact match only
        return null;
    }
    async reconcileBatch(userId, importBatchId) {
        // Stub: implement actual reconciliation logic
        return { success: true, userId, importBatchId, reconciled: true };
    }
}
exports.ReconciliationService = ReconciliationService;
