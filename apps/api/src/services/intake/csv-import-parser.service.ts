import { ImportRow } from '../../domain/intake/import-row';

export class CsvImportParserService {
  static parseCsvRows(csvRows: Record<string, unknown>[]): ImportRow[] {
    // Assume csvRows is an array of objects from a CSV parser
    return csvRows.map((row, idx) => ({
      rowId: '', // to be filled by import service
      batchId: '', // to be filled by import service
      rowNumber: idx + 1,
      rawJson: row,
      status: 'new',
    }));
  }
}
