// --- STUBS for orchestration types ---
export interface MarketDataEvent {
  eventType: string;
  cardKey?: string;
  timestamp?: string;
  [key: string]: any;
}

export interface SnapshotRefreshRequest {
  cardKey: string;
  snapshotType: string;
  requestedAt: string;
  [key: string]: any;
}
// PortfolioIQ types
export interface PortfolioAddRequest {
  player: string;
  cardTitle: string;
  cardSet: string;
  parallel: string;
  isAuto: boolean;
  grade: string;
  quantity: number;
  costBasis: number;
  notes?: string;
}

export interface PortfolioHolding extends PortfolioAddRequest {
  estimatedUnitValue: number;
  estimatedTotalValue: number;
  gainLossAmount: number;
  gainLossPercent: number;
  statusFlag: "Hold" | "Monitor" | "Sell";
  confidence: number;
  warnings: string[];
  nextActions: string[];
}

export interface PortfolioListResponse {
  success: boolean;
  holdings: PortfolioHolding[];
}

export interface PortfolioSummaryResponse {
  success: boolean;
  totalHoldings: number;
  totalCostBasis: number;
  totalEstimatedValue: number;
  totalGainLossAmount: number;
  totalGainLossPercent: number;
  topWinners: PortfolioHolding[];
  topRiskPositions: PortfolioHolding[];
}
// DailyIQ types
export interface DailyIQBriefResponse {
  success: boolean;
  briefDate: string;
  verifiedTopProspectPerformances: {
    hitters: DailyIQPlayer[];
    pitchers: DailyIQPlayer[];
  };
  prospectWatch: DailyIQPlayer[];
  hobbyMovers: DailyIQPlayer[];
  multiAppearanceTracker: DailyIQPlayer[];
}

export interface DailyIQPlayer {
  player: string;
  organization: string;
  level: string;
  position: string;
  firstBowmanYear: number;
  statLine: string;
  performanceNote: string;
  marketSignal: string;
  buySellTag: string;
  trendNote: string;
  watchReason: string;
}
// Shared types for HobbyIQ backend

export interface CompIQRequest {
  query: string;
}

export interface CompIQResponse {
  success: boolean;
  player: string | null;
  cardSet: string | null;
  productFamily: string | null;
  parallel: string | null;
  normalizedParallel: string | null;
  isAuto: boolean;
  rawPrice: number;
  adjustedRaw: number;
  estimatedPsa9: number;
  estimatedPsa10: number;
  confidenceScore: number;
  confidenceLabel: string;
  explanation: string;
  warnings: string[];
  nextActions: string[];
  ebaySupply: EbaySupplySnapshot;
}

export interface PlayerIQRequest {
  player: string;
}

export interface PlayerIQResponse {
  success: boolean;
  player: string;
  organization: string | null;
  level: string | null;
  overallScore: number;
  talentScore: number;
  marketScore: number;
  riskScore: number;
  riskLabel: string;
  summary: string;
  strengths: string[];
  risks: string[];
  recommendation: string;
  confidence: number;
  cardMarketSnapshot?: CardMarketSnapshot;
  topGemRateCards?: GemRateCard[];
  topParallelsToBuy: TopParallelToBuy[];
  buyOpportunities?: BuyOpportunity[];
  ebaySupplySnapshot: EbaySupplySnapshot;
}

export interface TopParallelToBuy {
  cardName: string;
  parallel: string;
  estimatedMarketPrice: number;
  estimatedFairValue: number;
  buyRating: "Strong Buy" | "Buy" | "Watch" | "Avoid";
  valueGap: number;
  liquiditySignal: string;
  scarcitySignal: string;
  gemRateSignal: string;
  whyItsABuy: string;
  buyUnder: number;
  confidence: number;
  // eBay supply fields
  activeListings: number | null;
  twoWeekSupplyChangePercent: number | null;
  supplyTrend: EbaySupplyTrend | null;
  supplyPressure: EbaySupplySignal | null;
}

export type EbaySupplyTrend = "Rising" | "Flat" | "Falling" | "Unavailable";
export type EbaySupplySignal = "Tightening" | "Stable" | "Expanding" | "Flooded" | "Unavailable";

export interface EbaySupplySnapshot {
  currentActiveListings: number | null;
  twoWeekSupplyChangePercent: number | null;
  twoWeekSupplyTrend: EbaySupplyTrend;
  supplySignal: EbaySupplySignal;
  supplyNote: string;
  fallback?: boolean;
}

export interface BuyOpportunity {
  cardName: string;
  parallel: string;
  notes: string;
  estimatedMarketPrice: number;
  estimatedFairValue: number;
  buyRating: "Strong Buy" | "Buy" | "Watch" | "Avoid";
  valueGap: number;
  confidence: number;
}

export interface CardMarketSnapshot {
  baseAutoRaw: number;
  baseAutoPsa10: number;
  marketTrend: string;
  marketSummary: string;
}

export interface GemRateCard {
  cardName: string;
  parallel: string;
  estimatedGemRate: number;
  populationSignal: string;
  scarcitySignal: string;
  gradingRecommendation: string;
}
