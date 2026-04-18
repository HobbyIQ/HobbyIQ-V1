import { ImportBatch, ImportSourceType } from '../../domain/intake/import-batch';
import { ImportRow } from '../../domain/intake/import-row';
import { ImportResult } from '../../domain/intake/import-result';
import { ImportBatchRepository } from '../../repositories/import-batch.repository';
import { ImportRowRepository } from '../../repositories/import-row.repository';
import { ReconciliationRepository } from '../../repositories/reconciliation.repository';
import { PortfolioPositionRepository } from '../../repositories/portfolio/portfolio-position.repository';
import { v4 as uuidv4 } from 'uuid';

export class PortfolioImportService {
  constructor(
    private readonly batchRepo: ImportBatchRepository,
    private readonly rowRepo: ImportRowRepository,
    private readonly reconciliationRepo: ReconciliationRepository,
    private readonly positionRepo: PortfolioPositionRepository
  ) {}

  async runManualImport(userId: string, rows: Record<string, unknown>[]): Promise<ImportResult> {
    const batch: ImportBatch = {
      batchId: uuidv4(),
      userId,
      sourceType: 'manual',
      status: 'started',
      createdAt: new Date().toISOString(),
      totalRows: rows.length,
      createdCount: 0,
      updatedCount: 0,
      matchedCount: 0,
      failedCount: 0,
    };
    await this.batchRepo.createBatch(batch);
    let created = 0, updated = 0, matched = 0, failed = 0;
    const errors: ImportResult['errors'] = [];
    for (let i = 0; i < rows.length; i++) {
      const row: ImportRow = {
        rowId: uuidv4(),
        batchId: batch.batchId,
        rowNumber: i + 1,
        rawJson: rows[i],
        status: 'new',
      };
      try {
        await this.rowRepo.createRow(row);
        // TODO: Validate, reconcile, create/update positions as needed
        created++;
      } catch (e: any) {
        failed++;
        errors.push({ rowNumber: i + 1, code: 'IMPORT_ERROR', message: e.message });
      }
    }
    batch.status = failed > 0 ? (created > 0 ? 'partial' : 'failed') : 'completed';
    batch.createdCount = created;
    batch.updatedCount = updated;
    batch.matchedCount = matched;
    batch.failedCount = failed;
    await this.batchRepo.updateBatch(batch);
    return {
      batchId: batch.batchId,
      status: batch.status,
      created,
      updated,
      matched,
      failed,
      errors,
    };
  }
}
