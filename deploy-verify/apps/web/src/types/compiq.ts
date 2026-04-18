// Types for CompIQ frontend

export interface CompIQRequest {
  query: string;
  player?: string;
  set?: string;
  parallel?: string;
  gradeTarget?: string;
  isAuto?: boolean;
}

export interface CompIQResponse {
  success: boolean;
  player: string | null;
  cardSet: string | null;
  productFamily: string | null;
  parallel: string | null;
  normalizedParallel: string | null;
  isAuto: boolean;
  cardType: string | null;
  rawPrice: number | null;
  adjustedRaw: number | null;
  estimatedPsa9: number | null;
  estimatedPsa10: number | null;
  confidenceScore: number;
  confidenceLabel: string;
  explanation: string;
  warnings: string[];
  nextActions: string[];
  ebaySupply: EbaySupplySnapshot;
  // Market intelligence extensions
  pricingBands?: MarketPriceBands;
  marketSignals?: MarketSignals;
  marketLadder?: MarketLadderRung[];
  supplyDemandTrends?: SupplyDemandWindow[];
  goodBuys?: BuyOpportunity[];
  recentComps?: RecentComp[];
  calculation?: CompCalculationMeta;
  // Advanced decision intelligence
  aiThesis?: AiThesis;
  riskPanel?: RiskPanel;
  entryExitPlan?: EntryExitPlan;
  compQuality?: CompQualityGrade;
  timeHorizonViews?: TimeHorizonView[];
  liquidityProfile?: LiquidityProfile;
  liquidityLadder?: LiquidityLadderRung[];
  marketTemperature?: MarketTemperature;
  guardrailFlags?: GuardrailFlags;
  listingQualityAssessments?: ListingQualityAssessment[];
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

export interface EntryExitPlan {
  idealEntry: number | null;
  acceptableEntryLow: number | null;
  acceptableEntryHigh: number | null;
  aggressiveEntry: number | null;
  firstProfitTake: number | null;
  strongSellZoneLow: number | null;
  strongSellZoneHigh: number | null;
  protectCapitalLevel: number | null;
  notes: string[];
}

export type CompQualityGradeLetter = "A" | "B" | "C" | "D";
export interface CompQualityGrade {
  grade: CompQualityGradeLetter;
  compCount: number;
  recencyScore: number;
  cleanlinessScore: number;
  normalizationRiskScore: number;
  thinMarket: boolean;
  outlierRisk: boolean;
  explanation: string[];
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

export type LiquidityLabel = "high" | "medium" | "low";
export interface LiquidityProfile {
  label: LiquidityLabel;
  avgDaysToMoveEstimate?: number;
  salesFrequencyScore: number;
  spreadRiskScore: number;
  explanation: string[];
}
export interface LiquidityLadderRung {
  label: string;
  estimatedPrice: number;
  liquidityLabel: LiquidityLabel;
  avgDaysToMoveEstimate?: number;
  activeSupply: number;
  salesVelocity: number;
}

export type MarketTemperatureLabel = "cold" | "warming" | "hot" | "overheated";
export interface MarketTemperature {
  label: MarketTemperatureLabel;
  score: number;
  explanation: string[];
}

export interface GuardrailFlags {
  possibleDamageRisk: boolean;
  parallelMismatchRisk: boolean;
  productMismatchRisk: boolean;
  gradeMismatchRisk: boolean;
  autoNonAutoContaminationRisk: boolean;
  megaMojoSapphireChromeContaminationRisk: boolean;
  oneOffMoonCompRisk: boolean;
  shillRiskPattern: boolean;
  thinSampleDistortionRisk: boolean;
  serialMismatchRisk: boolean;
  warnings: string[];
}

export type ListingFitTag = "best_value" | "best_flip" | "best_long_hold" | "best_collector_buy";
export type ListingQualityLabel = "excellent" | "good" | "mixed" | "poor";
export interface ListingQualityAssessment {
  listingId?: string;
  title: string;
  marketplace: string;
  listingPrice: number;
  sellerFeedbackPct?: number;
  sellerFeedbackCount?: number;
  acceptsReturns?: boolean;
  photoQualityScore: number;
  titleQualityScore: number;
  cardPresentationScore: number;
  underexposedOpportunityScore: number;
  riskFlags: string[];
  qualityLabel: ListingQualityLabel;
  fitTags: ListingFitTag[];
  notes: string[];
  listingUrl?: string;
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

export interface MarketPriceBands {
  quickExitPrice: number;
  fairMarketValue: number;
  buyZoneLow: number;
  buyZoneHigh: number;
  holdZoneLow: number;
  holdZoneHigh: number;
  sellZoneLow: number;
  sellZoneHigh: number;
  stretchAsk: number;
}

export interface MarketSignals {
  liquidityScore: number;
  confidenceScore: number;
  marketTrend: "rising" | "flat" | "cooling";
  supplyTrend2Weeks: "up" | "flat" | "down";
  supplyTrend4Weeks: "up" | "flat" | "down";
  supplyTrend3Months: "up" | "flat" | "down";
  demandTrend2Weeks: "up" | "flat" | "down";
  demandTrend4Weeks: "up" | "flat" | "down";
  demandTrend3Months: "up" | "flat" | "down";
  explanation: string[];
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

export interface SupplyDemandWindow {
  window: "2w" | "4w" | "3m";
  activeListingsAvg: number;
  soldCount: number;
  soldToListingRatio: number;
  absorptionRate: number;
  newListingVelocity: number;
  priceTrendPct: number;
  supplyTrendPct: number;
  demandTrendPct: number;
  signal: string;
}

export interface BuyOpportunity {
  title: string;
  marketplace: string;
  listingPrice: number;
  estimatedFmv: number;
  buyZoneLow: number;
  buyZoneHigh: number;
  estimatedUpsidePct: number;
  buyScore: number;
  reason: string;
  riskNotes: string[];
  listingUrl?: string;
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

export interface CompCalculationMeta {
  weightedMedian: number;
  weightedAverage: number;
  compCount: number;
  minComp?: number;
  maxComp?: number;
  methodologyNotes: string[];
}

export interface EbaySupplySnapshot {
  currentActiveListings: number | null;
  twoWeekSupplyChangePercent: number | null;
  twoWeekSupplyTrend: EbaySupplyTrend;
  supplySignal: EbaySupplySignal;
  supplyNote: string;
  fallback?: boolean;
  supplyPressure?: EbaySupplySignal;
}

export type EbaySupplyTrend = "Rising" | "Flat" | "Falling" | "Unavailable";
export type EbaySupplySignal = "Tightening" | "Stable" | "Expanding" | "Flooded" | "Unavailable";
