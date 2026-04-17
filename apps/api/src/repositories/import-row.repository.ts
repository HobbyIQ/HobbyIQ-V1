import { ImportRow } from '../domain/intake/import-row';

export interface ImportRowRepository {
  createRow(row: ImportRow): Promise<ImportRow>;
  updateRow(row: ImportRow): Promise<ImportRow>;
  listRowsByBatch(batchId: string): Promise<ImportRow[]>;
}
