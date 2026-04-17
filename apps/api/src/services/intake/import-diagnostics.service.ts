import { ImportBatch } from '../../domain/intake/import-batch';
import { ImportRow } from '../../domain/intake/import-row';

export class ImportDiagnosticsService {
  static summarize(batch: ImportBatch, rows: ImportRow[]) {
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
