import { ReconciliationMatch } from '../domain/intake/reconciliation-match';
import { ReconciliationDecision } from '../domain/intake/reconciliation-decision';

export interface ReconciliationRepository {
  saveMatch(match: ReconciliationMatch): Promise<ReconciliationMatch>;
  saveDecision(decision: ReconciliationDecision): Promise<ReconciliationDecision>;
  listMatchesByBatch(batchId: string): Promise<ReconciliationMatch[]>;
  listDecisionsByBatch(batchId: string): Promise<ReconciliationDecision[]>;
}
