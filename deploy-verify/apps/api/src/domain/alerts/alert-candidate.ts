export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertCandidateStatus = "new" | "suppressed" | "ready" | "sent" | "dismissed";
import { AlertRuleType } from "./alert-rule";

export interface AlertCandidate {
  candidateId: string;
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  ruleType: AlertRuleType;
  severity: AlertSeverity;
  title: string;
  summary: string;
  whyNow: string[];
  actionLabel?: string | null;
  confidenceScore: number;
  significanceScore: number;
  dedupeKey: string;
  sourceSnapshotId?: string;
  sourceChangeId?: string;
  status: AlertCandidateStatus;
  createdAt: string;
  metadataJson?: Record<string, unknown>;
}
