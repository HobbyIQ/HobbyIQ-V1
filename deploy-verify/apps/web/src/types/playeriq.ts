// Types for PlayerIQ frontend

export interface PlayerIQRequest {
  player: string;
  organization?: string;
  level?: string;
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
  warnings: string[];
  nextActions: string[];
  ebaySupplySnapshot: EbaySupplySnapshot;
  // Enhanced market intelligence section
  playerMarketSection?: PlayerIQMarketSection;
  // Advanced decision intelligence
  aiThesis?: AiThesis;
  riskPanel?: RiskPanel;
  catalystTracker?: CatalystTracker;
  portfolioFit?: PortfolioFit;
  timeHorizonViews?: TimeHorizonView[];
  marketTemperature?: MarketTemperature;
  marketMaturityStage?: MarketMaturityStage;
  recommendationSet?: PlayerRecommendationSet;
  actionPlan?: ActionPlan;

}

// --- Advanced Decision Intelligence Types ---
export type ThesisStance = "bullish" | "neutral" | "cautious" | "bearish";
export interface AiThesis {
  title: string;
  summary: string;
  bullets: string[];
  confidence: number;
  stance: ThesisStance;
}

export type RiskLabel = "low" | "moderate" | "high";
export interface RiskPanel {
  downsideRiskScore: number;
  volatilityScore: number;
  liquidityRiskScore: number;
  compQualityRiskScore: number;
  staleMarketRiskScore: number;
  spikeRiskScore: number;
  overallRiskLabel: RiskLabel;
  warnings: string[];
  explanation: string[];
}

export interface CatalystItem {
  category: "performance" | "promotion" | "ranking" | "injury" | "social" | "release_calendar" | "team_context" | "role";
  label: string;
  direction: "positive" | "neutral" | "negative";
  importance: number;
  timeframe: "immediate" | "near_term" | "medium_term";
  note: string;
}
export interface CatalystTracker {
  nextCatalysts: CatalystItem[];
  overallCatalystOutlook: "positive" | "mixed" | "negative";
  summary: string;
}

export type PortfolioFitLabel = "core_anchor" | "aggressive_upside" | "prospect_upside" | "quick_flip" | "collector_hold" | "avoid_for_now";
export interface PortfolioFit {
  fitLabel: PortfolioFitLabel;
  fitScore: number;
  overexposureWarning?: string;
  notes: string[];
}

export type TimeHorizonMode = "flip" | "swing" | "season" | "long_term";
export interface TimeHorizonView {
  mode: TimeHorizonMode;
  action: "buy" | "hold" | "watch" | "sell" | "avoid";
  rationale: string;
  targetEntry?: number;
  targetExit?: number;
  confidence: number;
  notes: string[];
}

export type MarketTemperatureLabel = "cold" | "warming" | "hot" | "overheated";
export interface MarketTemperature {
  label: MarketTemperatureLabel;
  score: number;
  explanation: string[];
}

export type MarketMaturityStageLabel = "discovery" | "rising" | "established" | "peak_hype" | "cooling";
export interface MarketMaturityStage {
  stage: MarketMaturityStageLabel;
  explanation: string;
}

export type PlayerActionTag = "buy" | "hold" | "watch" | "avoid" | "sell";
export interface PlayerTopCardRecommendation {
  cardName: string;
  actionTag: PlayerActionTag;
  estimatedFmv: number;
  entryTarget?: number;
  upsideLabel?: string;
  safetyLabel?: string;
  liquidityLabel?: string;
  reason: string[];
  risk: string[];
}
export interface PlayerRecommendationSet {
  bestRiskAdjustedCard?: PlayerTopCardRecommendation;
  bestUpsideCard?: PlayerTopCardRecommendation;
  safestLiquidCard?: PlayerTopCardRecommendation;
  topCardsToBuyNow: PlayerTopCardRecommendation[];
  topCardsToAvoidNow: PlayerTopCardRecommendation[];
}

export interface ActionPlan {
  bestBuyNow?: string;
  bestHold?: string;
  bestSellOrTrim?: string;
  why: string[];
  risk: string[];
  nextCatalystToWatch?: string;
  summary: string;
}
}

export interface PlayerIQMarketSection {
  playerMarketZone: {
    action: "buy" | "hold" | "sell" | "watch";
    buyZoneDescription: string;
    holdZoneDescription: string;
    sellZoneDescription: string;
  };
  bestCardsToBuyNow: TopParallelToBuy[];
  playerMarketLadder: MarketLadderRung[];
  playerMarketHealth: PlayerMarketHealth;
  recentCompsSupportingView: RecentComp[];
}

export interface MarketLadderRung {
  label: string;
  cardKey: string;
  estimatedPrice: number;
  compCount: number;
  liquidityScore: number;
  activeSupply: number;
  supplyTrend: "up" | "flat" | "down";
  demandTrend: "up" | "flat" | "down";
}

export interface PlayerMarketHealth {
  marketTrend: string;
  liquidity: string;
  supply: string;
  demand: string;
  downsideRisk: string;
  confidence: number;
  notes: string[];
}

export interface RecentComp {
  date: string;
  title: string;
  price: number;
  grade: string | null;
  source: string;
  listingType: "auction" | "bin" | "best_offer" | "unknown";
  acceptedOfferKnown: boolean;
  weight: number;
  normalized: boolean;
  notes?: string;
}

export interface EbaySupplySnapshot {
  currentActiveListings: number | null;
  twoWeekSupplyChangePercent: number | null;
  twoWeekSupplyTrend: EbaySupplyTrend;
  supplySignal: EbaySupplySignal;
  supplyNote: string;
  fallback?: boolean;
}

export type EbaySupplyTrend = "Rising" | "Flat" | "Falling" | "Unavailable";
export type EbaySupplySignal = "Tightening" | "Stable" | "Expanding" | "Flooded" | "Unavailable";

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
  activeListings: number | null;
  twoWeekSupplyChangePercent: number | null;
  supplyTrend: EbaySupplyTrend | null;
  supplyPressure: EbaySupplySignal | null;
}
