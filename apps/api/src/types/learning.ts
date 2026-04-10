// src/types/learning.ts
import type { FeatureKey, PlanTier } from "./plans";
import type { MarketSegmentKey, ProviderMode } from "./providers";

export type OutcomeDirection = "underpriced" | "overpriced" | "accurate";
export type RecommendationResult = "good" | "neutral" | "poor";
export type PromptExperimentStatus = "pending" | "running" | "completed" | "failed";
export type EvaluationSource = "mock" | "azure" | "manual";
export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";

export interface CompObservation {
  id: string;
  cardId: string;
  playerId: string;
  marketSegment: MarketSegmentKey;
  observedAt: string;
  compData: any; // raw comp record
}

export interface PricingSnapshot {
  id: string;
  cardId: string;
  playerId: string;
  marketSegment: MarketSegmentKey;
  fmvEstimate: number;
  buyTarget: number;
  sellTarget: number;
  confidenceScore: number;
  compSet: string[]; // comp ids
  weightsUsed: ModelWeightProfile;
  recommendation: string;
  createdAt: string;
}

export interface PricingOutcome {
  id: string;
  snapshotId: string;
  cardId: string;
  actualSalePrice: number;
  actualDaysToSell: number;
  saleType: string;
  acceptedOffer?: number;
  outcomeDate: string;
  direction: OutcomeDirection;
}

export interface ModelWeightProfile {
  id: string;
  marketSegment: MarketSegmentKey;
  weights: WeightAdjustment;
  version: string;
  createdAt: string;
  approved: boolean;
  priorVersion?: string;
}

export interface LearningAdjustmentLog {
  id: string;
  marketSegment: MarketSegmentKey;
  priorProfileId: string;
  newProfileId: string;
  adjustment: WeightAdjustment;
  explanation: string;
  sampleSize: number;
  accuracyBefore: number;
  accuracyAfter: number;
  dryRun: boolean;
  createdAt: string;
}

export interface PromptExperimentRun {
  id: string;
  promptVersion: string;
  status: PromptExperimentStatus;
  startedAt: string;
  completedAt?: string;
  metrics: EvaluationMetricLog[];
  providerMode: ProviderMode;
}

export interface EvaluationMetricLog {
  id: string;
  experimentId: string;
  metric: string;
  value: number;
  source: EvaluationSource;
  createdAt: string;
}

export interface AlertOutcomeLog {
  id: string;
  alertId: string;
  userId: string;
  outcome: string;
  triggeredAt: string;
  resolvedAt?: string;
  effectiveness: string;
}

export interface RecommendationOutcome {
  id: string;
  recommendationId: string;
  userId: string;
  result: RecommendationResult;
  observedAt: string;
}

export interface LearningJobResult {
  id: string;
  jobType: string;
  startedAt: string;
  completedAt: string;
  status: string;
  summary: string;
  details?: any;
}

export interface PromptVersion {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  version: string;
}

export interface WeightAdjustment {
  recencyWeight: number;
  exactGradeWeight: number;
  exactParallelWeight: number;
  sameSetWeight: number;
  autoMatchWeight: number;
  saleTypeAuctionWeight: number;
  saleTypeBinWeight: number;
  acceptedOfferWeight: number;
  outlierPenaltyWeight: number;
  liquidityAdjustmentWeight: number;
  scarcityAdjustmentWeight: number;
  volatilityPenaltyWeight: number;
}

export interface EvaluationScore {
  id: string;
  metric: string;
  value: number;
  createdAt: string;
}

export interface RecalibrationCandidate {
  id: string;
  marketSegment: MarketSegmentKey;
  sampleSize: number;
  priorProfileId: string;
  proposedProfile: ModelWeightProfile;
  explanation: string;
}
