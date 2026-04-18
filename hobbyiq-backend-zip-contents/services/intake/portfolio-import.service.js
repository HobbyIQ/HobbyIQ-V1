"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioImportService = void 0;
const uuid_1 = require("uuid");
class PortfolioImportService {
    constructor(batchRepo, rowRepo, reconciliationRepo, positionRepo) {
        this.batchRepo = batchRepo;
        this.rowRepo = rowRepo;
        this.reconciliationRepo = reconciliationRepo;
        this.positionRepo = positionRepo;
    }
    async runManualImport(userId, rows) {
        const batch = {
            batchId: (0, uuid_1.v4)(),
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
        const errors = [];
        for (let i = 0; i < rows.length; i++) {
            const row = {
                rowId: (0, uuid_1.v4)(),
                batchId: batch.batchId,
                rowNumber: i + 1,
                rawJson: rows[i],
                status: 'new',
            };
            try {
                await this.rowRepo.createRow(row);
                // TODO: Validate, reconcile, create/update positions as needed
                created++;
            }
            catch (e) {
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
exports.PortfolioImportService = PortfolioImportService;
