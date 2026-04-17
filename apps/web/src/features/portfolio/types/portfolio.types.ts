import { DecisionOutputDto, DecisionSummaryDto } from "../../decisions/types/decisions.types";

export interface PortfolioPositionLiteDto {
  positionId: string;
  userId: string;
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  quantity?: number;
  averageCost?: number | null;
  currentValue?: number | null;
  allocationPct?: number | null;
  convictionTag?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioActionViewDto {
  entityType: "card" | "player";
  entityKey: string;
  position?: PortfolioPositionLiteDto | null;
  decision: DecisionOutputDto;
  summary?: DecisionSummaryDto | null;
  alertCount?: number;
  freshness?: {
    asOf?: string;
    expiresAt?: string;
    isStale?: boolean;
    freshnessTier?: "hot" | "medium" | "cold";
    confidenceScore?: number;
    sourceCount?: number;
    dataCompletenessScore?: number;
  };
}
