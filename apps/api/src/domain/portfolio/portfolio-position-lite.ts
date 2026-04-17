export interface PortfolioPositionLite {
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
