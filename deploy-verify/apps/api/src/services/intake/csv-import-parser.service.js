"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CsvImportParserService = void 0;
class CsvImportParserService {
    static parseCsvRows(csvRows) {
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
exports.CsvImportParserService = CsvImportParserService;
