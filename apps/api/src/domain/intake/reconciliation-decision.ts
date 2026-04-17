export type ReconciliationAction = "create_new_position" | "update_existing_position" | "skip" | "manual_review";

export interface ReconciliationDecision {
  decisionId: string;
  matchId: string;
  action: ReconciliationAction;
  decidedAt: string;
  metadataJson?: Record<string, unknown>;
}
