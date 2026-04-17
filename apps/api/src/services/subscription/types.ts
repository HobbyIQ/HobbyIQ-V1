// Subscription plan models

export type SubscriptionPlan = "free" | "pro" | "all-star";

export interface PlanLimits {
  compiqSearches: number;
  playeriqEvaluations: number;
  dailyiqBriefs: number;
  holdings: number;
}

export interface Plan {
  name: SubscriptionPlan;
  label: string;
  description: string;
  limits: PlanLimits;
  features: string[];
}
