import { DecisionAction } from "./decision-action";

export interface DecisionOutput {
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
