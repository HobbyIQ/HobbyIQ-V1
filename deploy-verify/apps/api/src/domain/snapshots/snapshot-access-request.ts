// src/domain/snapshots/snapshot-access-request.ts
import { RefreshPriority, RefreshRequestedBy } from "../events/snapshot-refresh-request";

export interface SnapshotAccessRequest {
  entityType: "card" | "player";
  entityKey: string;
  priority?: RefreshPriority;
  forceRefresh?: boolean;
  requestedBy?: RefreshRequestedBy;
  reasonCodes?: string[];
}
