import { ImportRow } from '../../domain/intake/import-row';

export class ImportValidationService {
  static validateRow(row: ImportRow): string[] {
    const errors: string[] = [];
    const data = row.rawJson;
    if (!data.entityType || (data.entityType !== 'card' && data.entityType !== 'player')) errors.push('entityType must be card or player');
    if (!data.entityKey) errors.push('entityKey is required');
    if (typeof data.quantity !== 'number' || data.quantity <= 0) errors.push('quantity must be > 0');
    if (data.averageCost != null && data.averageCost < 0) errors.push('averageCost cannot be negative');
    return errors;
  }
}
