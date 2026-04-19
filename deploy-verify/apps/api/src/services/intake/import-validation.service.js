"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportValidationService = void 0;
class ImportValidationService {
    static validateRow(row) {
        const errors = [];
        const data = row.rawJson;
        if (!data.entityType || (data.entityType !== 'card' && data.entityType !== 'player'))
            errors.push('entityType must be card or player');
        if (!data.entityKey)
            errors.push('entityKey is required');
        if (typeof data.quantity !== 'number' || data.quantity <= 0)
            errors.push('quantity must be > 0');
        if (typeof data.averageCost === 'number' && data.averageCost < 0)
            errors.push('averageCost cannot be negative');
        return errors;
    }
}
exports.ImportValidationService = ImportValidationService;
