// In-memory storage for PortfolioIQ holdings (replace with DB in production)
import { PortfolioHolding, PortfolioHoldingInput } from "./types";

const holdings: Record<string, PortfolioHolding> = {};

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function addHolding(input: PortfolioHoldingInput): PortfolioHolding {
  const holdingId = generateId();
  const holding: PortfolioHolding = {
    ...input,
    holdingId,
    estimatedUnitValue: null,
    estimatedTotalValue: null,
    gainLossAmount: null,
    gainLossPercent: null,
    statusFlag: "Monitor",
    confidence: 0,
    warnings: [],
    nextActions: [],
  };
  holdings[holdingId] = holding;
  return holding;
}

export function listHoldings(): PortfolioHolding[] {
  return Object.values(holdings);
}

export function getHolding(holdingId: string): PortfolioHolding | undefined {
  return holdings[holdingId];
}

export function updateHolding(holding: PortfolioHolding) {
  holdings[holding.holdingId] = holding;
}

export function clearHoldings() {
  Object.keys(holdings).forEach(id => delete holdings[id]);
}
