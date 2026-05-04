export interface PortfolioHolding {
  id: number;
  playerName?: string;
  cardTitle?: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: number;
  quantity?: number;
  purchasePrice?: number;
  totalCostBasis?: number;
  currentValue?: number;
  quickSaleValue?: number;
  fairMarketValue?: number;
  premiumValue?: number;
  profitLoss?: number;
  profitLossPct?: number;
  freshnessStatus?: string;
  lastUpdated?: string;
  notes?: string;
}
