// Intake reconciliation job for bulk import
import { ReconciliationService } from '../services/intake/reconciliation.service';

export class IntakeReconciliationJob {
  constructor(private reconciliationService: ReconciliationService) {}

  async run(userId: string, importBatchId: string) {
    // Run reconciliation for a given import batch
    return this.reconciliationService.reconcileBatch(userId, importBatchId);
  }
}
