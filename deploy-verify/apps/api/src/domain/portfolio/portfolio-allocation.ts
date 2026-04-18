export interface PortfolioAllocationItem {
  entityType: "card" | "player";
  entityKey: string;
  displayLabel?: string;
  currentTotalValue: number;
  allocationPct: number;
  convictionTag?: string | null;
}

export interface PortfolioAllocationSummary {
  userId: string;
  totalEstimatedValue: number;
  totalCostBasis: number | null;
  totalUnrealizedGainLoss: number | null;
  totalUnrealizedGainLossPct: number | null;
  items: PortfolioAllocationItem[];
  updatedAt: string;
}
