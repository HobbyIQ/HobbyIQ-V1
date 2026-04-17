export type SyncProvider = "ebay" | "psa" | "portfolio_rollup" | "learning";
export type SyncRunStatus = "started" | "completed" | "failed" | "partial";

export interface SyncRun {
  syncRunId: string;
  userId?: string | null;
  provider: SyncProvider;
  status: SyncRunStatus;
  startedAt: string;
  completedAt?: string | null;
  recordsCreated: number;
  recordsUpdated: number;
  recordsMatched: number;
  errorsCount: number;
  summaryJson?: Record<string, unknown>;
  errorJson?: Record<string, unknown>;
}
