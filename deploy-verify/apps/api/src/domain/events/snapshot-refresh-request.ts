export type RefreshPriority = "high" | "medium" | "low";
export type RefreshRequestedBy = "system" | "schedule" | "user" | "dependency";

export interface SnapshotRefreshRequest {
  requestId: string;
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  reasonCodes: string[];
  requestedAt: string;
  priority: RefreshPriority;
  forceRefresh: boolean;
  requestedBy: RefreshRequestedBy;
  dependencyContextJson?: Record<string, unknown>;
}
