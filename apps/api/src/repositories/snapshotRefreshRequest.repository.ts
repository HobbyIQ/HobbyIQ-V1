import { SnapshotRefreshRequest } from "../domain/events/snapshot-refresh-request";

export interface SnapshotRefreshRequestRepository {
  save(request: SnapshotRefreshRequest): Promise<void>;
  findPendingByEntity(entityType: "card" | "player", entityKey: string): Promise<SnapshotRefreshRequest[]>;
}
