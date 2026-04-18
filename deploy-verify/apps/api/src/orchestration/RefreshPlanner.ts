import type { SnapshotRefreshRequest } from "../shared/types";
// Plans and batches refresh jobs
export interface RefreshPlanner {
  planRefreshes(requests: SnapshotRefreshRequest[]): Promise<PlannedRefreshBatch[]>;
}

export interface PlannedRefreshBatch {
  batchId: string;
  requests: SnapshotRefreshRequest[];
  priority: 'high' | 'medium' | 'low';
}
