export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertCandidateStatus = "new" | "suppressed" | "ready" | "sent" | "dismissed";
export type AlertChannel = "in_app" | "email" | "push";

export interface AlertCandidateDto {
  candidateId: string;
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  ruleType: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  whyNow: string[];
  actionLabel?: string | null;
  confidenceScore: number;
  significanceScore: number;
  status: AlertCandidateStatus;
  createdAt: string;
  metadataJson?: Record<string, unknown>;
}

export interface AlertSubscriptionDto {
  subscriptionId: string;
  userId: string;
  entityType: "card" | "player" | "portfolio" | "dailyiq";
  entityKey: string;
  channels: AlertChannel[];
  enabledRuleTypes: string[];
  minSeverity: AlertSeverity;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
