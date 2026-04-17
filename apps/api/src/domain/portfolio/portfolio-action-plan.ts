export interface PortfolioActionPlan {
  positionId: string;
  recommendedAction: "buy_more" | "hold" | "trim" | "sell" | "watch" | "avoid_adding";
  urgencyScore: number;
  confidenceScore: number;
  summary: string;
  whyNow: string[];
  actionSteps: string[];
  addRangeLow?: number | null;
  addRangeHigh?: number | null;
  trimRangeLow?: number | null;
  trimRangeHigh?: number | null;
  sellRangeLow?: number | null;
  sellRangeHigh?: number | null;
  protectCapitalLevel?: number | null;
  nextCatalyst?: string | null;
  updatedAt: string;
}
