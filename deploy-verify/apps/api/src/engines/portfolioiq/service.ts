import type { PortfolioHolding, PortfolioAddRequest, PortfolioSummaryResponse, PortfolioListResponse } from "../../shared/types";
import { handleCompIQLiveEstimate } from "../compiq/service";
import { validatePortfolioAddRequest } from "../../shared/validation";

const holdings: PortfolioHolding[] = [];


export async function addHolding(input: PortfolioAddRequest): Promise<PortfolioHolding> {
  validatePortfolioAddRequest(input);
  const estimate = await handleCompIQLiveEstimate({ query: input.cardTitle });
  const estimatedUnitValue = estimate.rawPrice;
  const estimatedTotalValue = estimatedUnitValue * input.quantity;
  const gainLossAmount = estimatedTotalValue - input.costBasis;
  const gainLossPercent = input.costBasis > 0 ? (gainLossAmount / input.costBasis) * 100 : 0;
  const statusFlag = gainLossAmount > 0 ? "Hold" : gainLossAmount < -50 ? "Sell" : "Monitor";
  const confidence = estimate.confidenceScore;
  const warnings = estimate.warnings;
  const nextActions = estimate.nextActions;
  const holding: PortfolioHolding = {
    ...input,
    estimatedUnitValue,
    estimatedTotalValue,
    gainLossAmount,
    gainLossPercent,
    statusFlag,
    confidence,
    warnings,
    nextActions
  };
  holdings.push(holding);
  return holding;
}

export async function listHoldings(): Promise<PortfolioListResponse> {
  return { success: true, holdings };
}

export async function getPortfolioSummary(): Promise<PortfolioSummaryResponse> {
  const totalHoldings = holdings.length;
  const totalCostBasis = holdings.reduce((sum, h) => sum + h.costBasis, 0);
  const totalEstimatedValue = holdings.reduce((sum, h) => sum + h.estimatedTotalValue, 0);
  const totalGainLossAmount = totalEstimatedValue - totalCostBasis;
  const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLossAmount / totalCostBasis) * 100 : 0;
  const topWinners = [...holdings].sort((a, b) => b.gainLossAmount - a.gainLossAmount).slice(0, 3);
  const topRiskPositions = [...holdings].sort((a, b) => a.gainLossAmount - b.gainLossAmount).slice(0, 3);
  return {
    success: true,
    totalHoldings,
    totalCostBasis,
    totalEstimatedValue,
    totalGainLossAmount,
    totalGainLossPercent,
    topWinners,
    topRiskPositions
  };
}
