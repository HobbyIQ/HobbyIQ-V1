import type { PlanTier } from "../models/planTiers";

export interface PlanDefinition {
  plan: PlanTier;
  features: string[];
}

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  { plan: "Prospect", features: ["basicAlerts"] },
  { plan: "All-Star", features: ["basicAlerts", "advancedAlerts"] },
  { plan: "Dealer Pro", features: ["basicAlerts", "advancedAlerts", "premiumSignals"] },
];
