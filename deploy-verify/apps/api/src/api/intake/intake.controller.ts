import { Router, Request, Response } from 'express';

// Type augmentation for Express Request to include user property
declare global {
  namespace Express {
    interface User {
      id: string;
      [key: string]: any;
    }
    interface Request {
      user: User;
    }
  }
}
import { PortfolioImportService } from '../../services/intake/portfolio-import.service';
import { CsvImportParserService } from '../../services/intake/csv-import-parser.service';
import { ImportValidationService } from '../../services/intake/import-validation.service';
import { ReconciliationService } from '../../services/intake/reconciliation.service';
import { IntakeReconciliationJob } from '../../jobs/intake-reconciliation.job';
import { ImportDiagnosticsService } from '../../services/intake/import-diagnostics.service';
import { ImportBatchRepository } from '../../repositories/import-batch.repository';
import { ImportRowRepository } from '../../repositories/import-row.repository';


export function createIntakeController(importService: PortfolioImportService): Router {
  const router = Router();
  // Compose additional services (in real app, inject via DI)
  const reconciliationService = new ReconciliationService(importService["positionRepo"]);


  // POST /api/intake/manual
  router.post('/manual', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const rows = req.body.rows;
    const result = await importService.runManualImport(userId, rows);
    res.json(result);
  });

  // POST /api/intake/csv
  router.post('/csv', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const csvRows = req.body.rows;
    const parsedRows = CsvImportParserService.parseCsvRows(csvRows);
    // Validate all rows
    const validationResults = parsedRows.map(row => ({
      rowNumber: row.rowNumber,
      errors: ImportValidationService.validateRow(row)
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
  router.get('/batch/:batchId', async (req: Request, res: Response) => {
    // Find batch and rows
    const batchRepo: ImportBatchRepository = importService["batchRepo"];
    const rowRepo: ImportRowRepository = importService["rowRepo"];
    const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
    const batch = await batchRepo.getBatchById(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const rows = await rowRepo.listRowsByBatch(batch.batchId);
    res.json({ batch, rows });
  });


  // POST /api/intake/reconcile/:batchId
  router.post('/reconcile/:batchId', async (req: Request, res: Response) => {
    // Run reconciliation job for a batch
    const userId = req.user.id;
    const reconciliationService = new ReconciliationService(importService["positionRepo"]);
    const job = new IntakeReconciliationJob(reconciliationService);
    const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
    const result = await job.run(userId, batchId);
    res.json(result);
  });


  // GET /api/intake/diagnostics/:batchId
  router.get('/diagnostics/:batchId', async (req: Request, res: Response) => {
    const batchRepo: ImportBatchRepository = importService["batchRepo"];
    const rowRepo: ImportRowRepository = importService["rowRepo"];
    const batchId = Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId;
    const batch = await batchRepo.getBatchById(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const rows = await rowRepo.listRowsByBatch(batch.batchId);
    const summary = ImportDiagnosticsService.summarize(batch, rows);
    res.json(summary);
  });

  return router;
}
