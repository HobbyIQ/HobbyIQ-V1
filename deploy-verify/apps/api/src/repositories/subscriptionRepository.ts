// Mock subscription repository for HobbyIQ
import type { PlanTier } from "../types/plans";

export function getUserPlan(userId: string): PlanTier {
  // Always return 'Dealer Pro' in mock mode
  return 'Dealer Pro';
}
