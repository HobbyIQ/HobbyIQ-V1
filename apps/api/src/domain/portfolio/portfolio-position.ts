export interface PortfolioPosition {
  positionId: string;
  userId: string;
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  displayLabel?: string;
  quantity: number;
  averageCost: number | null;
  totalCostBasis: number | null;
  currentModeledValue: number | null;
  currentTotalValue: number | null;
  unrealizedGainLoss: number | null;
  unrealizedGainLossPct: number | null;
  convictionTag?: "core" | "upside" | "flip" | "pc" | "spec" | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}
