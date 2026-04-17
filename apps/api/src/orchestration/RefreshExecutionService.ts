// Executes refresh jobs, updates cache and persistence
export interface RefreshExecutionService {
  executeBatch(batch: PlannedRefreshBatch): Promise<void>;
}

import { PlannedRefreshBatch } from './RefreshPlanner';
