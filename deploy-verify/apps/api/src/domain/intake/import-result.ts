export type ImportResultStatus = "completed" | "failed" | "partial";

export interface ImportResult {
  batchId: string;
  status: ImportResultStatus;
  created: number;
  updated: number;
  matched: number;
  failed: number;
  errors: Array<{ rowNumber?: number; code: string; message: string }>;
}
