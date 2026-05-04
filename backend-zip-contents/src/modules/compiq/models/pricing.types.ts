export interface PriceLanes {
  quickSaleValue: number;
  fairMarketValue: number;
  premiumValue: number;
  ceilingValue?: number;
}
// Placeholder for missing types
export interface NetValueLanes {
  grossQuickSaleValue: number;
  grossFairMarketValue: number;
  grossPremiumValue: number;
  netQuickSaleValue: number;
  netFairMarketValue: number;
  netPremiumValue: number;
}

export interface ScenarioValues {
  bearCaseValue: number;
  baseCaseValue: number;
}

export interface ObservabilitySnapshot {
  // Add fields as needed
  [key: string]: any;
}
// Pricing domain types for HobbyIQ
// import { CardIdentity, ProvenanceScore } from './identity.types';
// import { ObservabilitySnapshot } from './observability.types';


export interface CardSubject {
  playerName: string;
  cardYear?: number;
  brand?: string;
  setName?: string;
  product?: string;
  parallel?: string;
  serialNumber?: string;
  variation?: string;
  gradeCompany?: string;
  gradeValue?: number | string;
  isAuto?: boolean;
  isPatch?: boolean;
  team?: string;
  cardNumber?: string;
}

/**
 * @typedef {Object} PriceLanes
 * @property {number} quickSaleValue
 * @property {number} fairMarketValue
 * @property {number} premiumValue
 * @property {number=} ceilingValue
 */

/**
 * @typedef {Object} NetValueLanes
 * @property {number} grossQuickSaleValue
 * @property {number} grossFairMarketValue
 * @property {number} grossPremiumValue
 * @property {number} netQuickSaleValue
 * @property {number} netFairMarketValue
 * @property {number} netPremiumValue
 */

/**
 * @typedef {Object} ScenarioValues
 * @property {number} bearCaseValue
 * @property {number} baseCaseValue
 */

module.exports = {};

export interface ConfidenceBundle {
  pricingConfidence: number;
  liquidityConfidence: number;
  timingConfidence: number;
}

export interface ExitStrategyResult {
  recommendedMethod: 'auction' | 'bin';
  expectedDaysToSell: number | null;
  timingRecommendation: 'sell_now' | 'hold' | 'list_high_and_wait' | 'auction_now';
  reasoning: string[];
}

export interface MarketDNA {
  demand: 'high' | 'medium' | 'low';
  liquidity: 'high' | 'medium' | 'low';
  volatility: 'high' | 'medium' | 'low';
  risk: 'high' | 'medium' | 'low';
  trend: 'up' | 'flat' | 'down';
}

export interface ExplainabilityBundle {
  acceptedCompIds: string[];
  rejectedCompIds: Array<{ id?: string; reason: string }>;
  multiplierRationale: Record<string, string>;
  confidenceDrivers: string[];
  pricingDrivers: string[];
}

export interface DynamicPricingResult {
  subject: CardSubject;
  priceLanes: PriceLanes;
  netValueLanes: NetValueLanes;
  scenarioValues: ScenarioValues;
  dealScore: number;
  dealLabel?: string;
  roi: { roi30d: number; roi90d: number; roi6m: number };
  market: {
    marketSpeed: 'fast' | 'normal' | 'slow';
    marketPressure: 'buyers' | 'balanced' | 'sellers';
    absorptionRate: number | null;
    avgDaysToSell: number | null;
    marketRegime: 'bull' | 'neutral' | 'bear';
  };
  confidence: ConfidenceBundle;
  arbitrage: {
    signal: 'underpriced' | 'fair' | 'overpriced';
    mispricingDeltaPct: number;
  };
  exitStrategy: ExitStrategyResult;
  marketDNA: MarketDNA;
  alerts: string[];
  explanation: string[];
  compSummary: string[];
  explainability: ExplainabilityBundle;
  observability: ObservabilitySnapshot;
  debug?: any;
}
