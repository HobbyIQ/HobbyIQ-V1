// src/services/learning/learningService.ts
import { compObservationRepository } from "../../repositories/compObservationRepository";
import { pricingSnapshotRepository } from "../../repositories/pricingSnapshotRepository";
import { pricingOutcomeRepository } from "../../repositories/pricingOutcomeRepository";
import { modelWeightProfileRepository } from "../../repositories/modelWeightProfileRepository";
import { learningAdjustmentLogRepository } from "../../repositories/learningAdjustmentLogRepository";
import { promptExperimentRunRepository } from "../../repositories/promptExperimentRunRepository";
import { evaluationMetricLogRepository } from "../../repositories/evaluationMetricLogRepository";
import { alertOutcomeLogRepository } from "../../repositories/alertOutcomeLogRepository";
import { recommendationOutcomeRepository } from "../../repositories/recommendationOutcomeRepository";
import { aiProviderFactory } from "../../providers/factories/aiProviderFactory";
import { searchProviderFactory } from "../../providers/factories/searchProviderFactory";
import { storageProviderFactory } from "../../providers/factories/storageProviderFactory";
import { monitoringProviderFactory } from "../../providers/factories/monitoringProviderFactory";
import { cacheProviderFactory } from "../../providers/factories/cacheProviderFactory";
import { getMarketSegment } from "../../utils/marketSegmentation";
import { PricingSnapshot, PricingOutcome, ModelWeightProfile, LearningAdjustmentLog, PromptExperimentRun, EvaluationMetricLog, AlertOutcomeLog, RecommendationOutcome } from "../../types/learning";

export const learningService = {
  getCompObservations: compObservationRepository.getAll,
  getPricingSnapshots: pricingSnapshotRepository.getAll,
  getPricingOutcomes: pricingOutcomeRepository.getAll,
  getModelWeightProfiles: modelWeightProfileRepository.getAll,
  getLearningAdjustmentLogs: learningAdjustmentLogRepository.getAll,
  getPromptExperimentRuns: promptExperimentRunRepository.getAll,
  getEvaluationMetricLogs: evaluationMetricLogRepository.getAll,
  getAlertOutcomeLogs: alertOutcomeLogRepository.getAll,
  getRecommendationOutcomes: recommendationOutcomeRepository.getAll,
  getMarketSegment,
  aiProviderFactory,
  searchProviderFactory,
  storageProviderFactory,
  monitoringProviderFactory,
  cacheProviderFactory,
};
