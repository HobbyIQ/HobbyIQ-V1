export interface PortfolioPositionMetrics {
  positionId: string;
  quantity: number;
  averageCost: number | null;
  totalCostBasis: number | null;
  currentModeledValue: number | null;
  currentTotalValue: number | null;
  unrealizedGainLoss: number | null;
  unrealizedGainLossPct: number | null;
  allocationPct: number | null;
  riskScore?: number | null;
  decisionAction?: string | null;
  actionConfidence?: number | null;
  freshnessAsOf?: string | null;
}
