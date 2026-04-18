import type { SnapshotRefreshRequest } from "../shared/types";
// Dedupes refresh jobs and prevents duplicate execution
export interface RefreshDeduper {
  isDuplicate(request: SnapshotRefreshRequest): Promise<boolean>;
  markInProgress(request: SnapshotRefreshRequest): Promise<void>;
  markComplete(request: SnapshotRefreshRequest): Promise<void>;
}
