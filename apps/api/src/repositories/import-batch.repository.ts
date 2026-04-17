import { ImportBatch } from '../domain/intake/import-batch';

export interface ImportBatchRepository {
  createBatch(batch: ImportBatch): Promise<ImportBatch>;
  updateBatch(batch: ImportBatch): Promise<ImportBatch>;
  listBatchesByUser(userId: string): Promise<ImportBatch[]>;
  getBatchById(batchId: string): Promise<ImportBatch | null>;
}
