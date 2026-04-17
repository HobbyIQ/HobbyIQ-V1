export type DecisionAction =
  | "strong_buy"
  | "buy"
  | "watch_buy"
  | "hold"
  | "trim"
  | "sell"
  | "strong_sell"
  | "avoid";

export interface DecisionOutputDto {
  decisionId: string;
  entityType: "card" | "player";
  entityKey: string;
  primaryAction: DecisionAction;
  actionConfidence: number;
  urgencyScore: number;
  convictionScore: number;
  riskScore: number;
  explanationTitle: string;
  explanationSummary: string;
  whyNow: string[];
  reasonsForAction: string[];
  reasonsForCaution: string[];
  idealActionPrice?: number | null;
  trimZoneLow?: number | null;
  trimZoneHigh?: number | null;
  sellZoneLow?: number | null;
  sellZoneHigh?: number | null;
  protectCapitalLevel?: number | null;
  catalystToWatch?: string | null;
  marketTemperature?: string | null;
  liquidityLabel?: string | null;
  generatedAt: string;
  methodologyVersion: string;
}

export interface DecisionSummaryDto {
  headline: string;
  shortWhy: string;
  whatChanged: string[];
  nextBestAction: string;
  caution: string[];
}
