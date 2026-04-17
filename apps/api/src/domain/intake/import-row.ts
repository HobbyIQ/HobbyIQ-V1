export type ImportRowStatus = "new" | "validated" | "matched" | "created" | "updated" | "failed" | "skipped";

export interface ImportRow {
  rowId: string;
  batchId: string;
  rowNumber: number;
  rawJson: Record<string, unknown>;
  normalizedJson?: Record<string, unknown>;
  status: ImportRowStatus;
  errorMessage?: string | null;
}
