"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIntakeController = createIntakeController;
const express_1 = require("express");
const csv_import_parser_service_1 = require("../../services/intake/csv-import-parser.service");
const import_validation_service_1 = require("../../services/intake/import-validation.service");
const reconciliation_service_1 = require("../../services/intake/reconciliation.service");
const intake_reconciliation_job_1 = require("../../jobs/intake-reconciliation.job");
const import_diagnostics_service_1 = require("../../services/intake/import-diagnostics.service");
function createIntakeController(importService) {
    const router = (0, express_1.Router)();
    // Compose additional services (in real app, inject via DI)
    const reconciliationService = new reconciliation_service_1.ReconciliationService(importService["positionRepo"]);
    // POST /api/intake/manual
    router.post('/manual', async (req, res) => {
        const userId = req.user.id;
        const rows = req.body.rows;
        const result = await importService.runManualImport(userId, rows);
        res.json(result);
    });
    // POST /api/intake/csv
    router.post('/csv', async (req, res) => {
        const userId = req.user.id;
        const csvRows = req.body.rows;
        const parsedRows = csv_import_parser_service_1.CsvImportParserService.parseCsvRows(csvRows);
        // Validate all rows
        const validationResults = parsedRows.map(row => ({
            rowNumber: row.rowNumber,
            errors: import_validation_service_1.ImportValidationService.validateRow(row)
        }));
        // If any row has errors, return 400
        if (validationResults.some(r => r.errors.length > 0)) {
            return res.status(400).json({ validation: validationResults });
        }
        // Otherwise, run import
        const result = await importService.runManualImport(userId, csvRows);
        res.json(result);
    });
    // GET /api/intake/batch/:batchId
    router.get('/batch/:batchId', async (req, res) => {
        // Find batch and rows
        const batchRepo = importService["batchRepo"];
        const rowRepo = importService["rowRepo"];
        const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
        const batch = await batchRepo.getBatchById(batchId);
        if (!batch)
            return res.status(404).json({ error: 'Batch not found' });
        const rows = await rowRepo.listRowsByBatch(batch.batchId);
        res.json({ batch, rows });
    });
    // POST /api/intake/reconcile/:batchId
    router.post('/reconcile/:batchId', async (req, res) => {
        // Run reconciliation job for a batch
        const userId = req.user.id;
        const reconciliationService = new reconciliation_service_1.ReconciliationService(importService["positionRepo"]);
        const job = new intake_reconciliation_job_1.IntakeReconciliationJob(reconciliationService);
        const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
        const result = await job.run(userId, batchId);
        res.json(result);
    });
    // GET /api/intake/diagnostics/:batchId
    router.get('/diagnostics/:batchId', async (req, res) => {
        const batchRepo = importService["batchRepo"];
        const rowRepo = importService["rowRepo"];
        const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
        const batch = await batchRepo.getBatchById(batchId);
        if (!batch)
            return res.status(404).json({ error: 'Batch not found' });
        const rows = await rowRepo.listRowsByBatch(batch.batchId);
        const summary = import_diagnostics_service_1.ImportDiagnosticsService.summarize(batch, rows);
        res.json(summary);
    });
    return router;
}
