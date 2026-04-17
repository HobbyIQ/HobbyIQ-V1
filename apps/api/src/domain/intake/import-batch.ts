export type ImportSourceType = "manual" | "csv" | "ebay" | "psa";
export type ImportBatchStatus = "started" | "completed" | "failed" | "partial";

export interface ImportBatch {
  batchId: string;
  userId: string;
  sourceType: ImportSourceType;
  status: ImportBatchStatus;
  createdAt: string;
  completedAt?: string | null;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  matchedCount: number;
  failedCount: number;
  summaryJson?: Record<string, unknown>;
}
