"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportDiagnosticsService = void 0;
class ImportDiagnosticsService {
    static summarize(batch, rows) {
        return {
            created: batch.createdCount,
            updated: batch.updatedCount,
            matched: batch.matchedCount,
            failed: batch.failedCount,
            manualReview: rows.filter(r => r.status === 'skipped').length,
            duplicateRows: rows.length - new Set(rows.map(r => r.rawJson.entityKey)).size,
            unmatchedRows: rows.filter(r => r.status === 'new').length,
        };
    }
}
exports.ImportDiagnosticsService = ImportDiagnosticsService;
