// Extended domain models for advanced market intelligence

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

export type CatalystCategory = "performance" | "promotion" | "ranking" | "injury" | "social" | "release_calendar" | "team_context" | "role";
export type CatalystDirection = "positive" | "neutral" | "negative";
export type CatalystTimeframe = "immediate" | "near_term" | "medium_term";
export interface CatalystItem {
  category: CatalystCategory;
  label: string;
  direction: CatalystDirection;
  importance: number;
  timeframe: CatalystTimeframe;
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

export interface ActionPlan {
  bestBuyNow?: string;
  bestHold?: string;
  bestSellOrTrim?: string;
  why: string[];
  risk: string[];
  nextCatalystToWatch?: string;
  summary: string;
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

export type MarketMaturityStageLabel = "discovery" | "rising" | "established" | "peak_hype" | "cooling";
export interface MarketMaturityStage {
  stage: MarketMaturityStageLabel;
  explanation: string;
}

export interface CompIQDecisionExtension {
  aiThesis: AiThesis;
  riskPanel: RiskPanel;
  entryExitPlan: EntryExitPlan;
  compQuality: CompQualityGrade;
  timeHorizonViews: TimeHorizonView[];
  liquidityProfile: LiquidityProfile;
  liquidityLadder: LiquidityLadderRung[];
  marketTemperature: MarketTemperature;
  guardrailFlags: GuardrailFlags;
  listingQualityAssessments: ListingQualityAssessment[];
  actionPlan: ActionPlan;
}

export interface PlayerIQDecisionExtension {
  aiThesis: AiThesis;
  riskPanel: RiskPanel;
  catalystTracker: CatalystTracker;
  portfolioFit: PortfolioFit;
  timeHorizonViews: TimeHorizonView[];
  marketTemperature: MarketTemperature;
  marketMaturityStage: MarketMaturityStage;
  recommendationSet: PlayerRecommendationSet;
  actionPlan: ActionPlan;
}
