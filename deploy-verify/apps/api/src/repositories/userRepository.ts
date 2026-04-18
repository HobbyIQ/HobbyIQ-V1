// In-memory mock user repository for HobbyIQ
import { PlanTier } from "../models/planTiers";

export interface MockUser {
  id: string;
  plan: PlanTier;
  features: string[];
  planLimits: any;
}

const MOCK_USERS: Record<string, MockUser> = {
  "mock-user": {
    id: "mock-user",
    plan: "Prospect",
    features: ["basicAlerts"],
    planLimits: { maxInAppAlerts: 5, premiumSignals: false },
  },
  "premium-user": {
    id: "premium-user",
    plan: "Dealer Pro",
    features: ["basicAlerts", "advancedAlerts", "premiumSignals"],
    planLimits: { maxInAppAlerts: null, premiumSignals: true },
  },
  "allstar-user": {
    id: "allstar-user",
    plan: "All-Star",
    features: ["basicAlerts", "advancedAlerts"],
    planLimits: { maxInAppAlerts: null, premiumSignals: false },
  },
};

export function getUserById(id: string): MockUser | undefined {
  return MOCK_USERS[id];
}
