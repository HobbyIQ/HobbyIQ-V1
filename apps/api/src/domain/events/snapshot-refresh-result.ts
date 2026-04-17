export type RefreshPath =
  | "cache_hit"
  | "gold_hit"
  | "silver_rebuild"
  | "live_fetch_then_rebuild";

export type RefreshStatus = "success" | "skipped" | "failed";

export interface SnapshotRefreshResult {
  resultId: string;
  requestId: string;
  entityType: "card" | "player";
  entityKey: string;
  startedAt: string;
  completedAt?: string;
  status: RefreshStatus;
  refreshPath: RefreshPath;
  snapshotId?: string;
  oldSnapshotId?: string;
  changeSummaryJson?: Record<string, unknown>;
  diagnosticsJson?: Record<string, unknown>;
  errorMessage?: string;
}
