import { PLAN_DEFINITIONS } from "../constants/plans";
import { PlanTier } from "../types/plans";
import { FeatureKey } from "../constants/features";

// Returns all unlocked features for a given plan
export function getUnlockedFeatures(plan: PlanTier): FeatureKey[] {
  const def = PLAN_DEFINITIONS.find(p => p.plan === plan);
  return (def?.features || []) as FeatureKey[];
}
