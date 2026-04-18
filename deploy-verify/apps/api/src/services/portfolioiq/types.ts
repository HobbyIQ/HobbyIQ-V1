export interface AddHoldingResponse extends PortfolioHolding {
  success: boolean;
}

export interface ListHoldingsResponse {
  success: boolean;
  holdings: PortfolioHolding[];
}

export interface PortfolioSummaryResponse {
  success: boolean;
  summary: PortfolioSummary;
  warnings: string[];
  nextActions: string[];
}
// PortfolioIQ strongly typed models

export interface PortfolioHoldingInput {
  player: string;
  cardTitle?: string;
  cardSet: string;
  parallel?: string;
  grade?: string;
  isAuto?: boolean;
  quantity: number;
  costBasis: number;
  notes?: string;
}

export interface PortfolioHolding extends PortfolioHoldingInput {
  holdingId: string;
  estimatedUnitValue: number | null;
  estimatedTotalValue: number | null;
  gainLossAmount: number | null;
  gainLossPercent: number | null;
  statusFlag: "Hold" | "Monitor" | "Sell";
  confidence: number;
  warnings: string[];
  nextActions: string[];
}

export interface PortfolioSummary {
  totalHoldings: number;
  totalCostBasis: number;
  totalEstimatedValue: number;
  totalGainLossAmount: number;
  totalGainLossPercent: number;
  topWinners: PortfolioHolding[];
  topRiskPositions: PortfolioHolding[];
}
