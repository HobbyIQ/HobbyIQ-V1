export type MatchType = "exact" | "fuzzy" | "provider_link" | "manual_review";

export interface ReconciliationMatch {
  matchId: string;
  batchId: string;
  rowId: string;
  entityType: "card" | "player";
  entityKey: string;
  positionId?: string | null;
  confidenceScore: number;
  matchType: MatchType;
  metadataJson?: Record<string, unknown>;
}
