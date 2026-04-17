export type AlertChannel = "in_app" | "email" | "push";
import { AlertRuleType } from "./alert-rule";
export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface AlertSubscription {
  subscriptionId: string;
  userId: string;
  entityType: "card" | "player" | "portfolio" | "dailyiq";
  entityKey: string;
  channels: AlertChannel[];
  enabledRuleTypes: AlertRuleType[];
  minSeverity: AlertSeverity;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
