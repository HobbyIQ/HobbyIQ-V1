import { SnapshotRefreshResult } from "../domain/events/snapshot-refresh-result";

export interface SnapshotRefreshResultRepository {
  save(result: SnapshotRefreshResult): Promise<void>;
}
