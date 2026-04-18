export interface PortfolioSummary {
  userId: string;
  totalPositions: number;
  totalEstimatedValue: number;
  totalCostBasis: number | null;
  totalUnrealizedGainLoss: number | null;
  totalUnrealizedGainLossPct: number | null;
  buyMoreCount: number;
  holdCount: number;
  trimCount: number;
  sellCount: number;
  watchCount: number;
  updatedAt: string;
}
