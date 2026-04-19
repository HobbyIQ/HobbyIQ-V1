"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.learningService = void 0;
// src/services/learning/learningService.ts
const compObservationRepository_1 = require("../../repositories/compObservationRepository");
const pricingSnapshotRepository_1 = require("../../repositories/pricingSnapshotRepository");
const pricingOutcomeRepository_1 = require("../../repositories/pricingOutcomeRepository");
const modelWeightProfileRepository_1 = require("../../repositories/modelWeightProfileRepository");
const learningAdjustmentLogRepository_1 = require("../../repositories/learningAdjustmentLogRepository");
const promptExperimentRunRepository_1 = require("../../repositories/promptExperimentRunRepository");
const evaluationMetricLogRepository_1 = require("../../repositories/evaluationMetricLogRepository");
const alertOutcomeLogRepository_1 = require("../../repositories/alertOutcomeLogRepository");
const recommendationOutcomeRepository_1 = require("../../repositories/recommendationOutcomeRepository");
const aiProviderFactory_1 = require("../../providers/factories/aiProviderFactory");
const searchProviderFactory_1 = require("../../providers/factories/searchProviderFactory");
const storageProviderFactory_1 = require("../../providers/factories/storageProviderFactory");
const monitoringProviderFactory_1 = require("../../providers/factories/monitoringProviderFactory");
const cacheProviderFactory_1 = require("../../providers/factories/cacheProviderFactory");
const marketSegmentation_1 = require("../../utils/marketSegmentation");
exports.learningService = {
    getCompObservations: compObservationRepository_1.compObservationRepository.getAll,
    getPricingSnapshots: pricingSnapshotRepository_1.pricingSnapshotRepository.getAll,
    getPricingOutcomes: pricingOutcomeRepository_1.pricingOutcomeRepository.getAll,
    getModelWeightProfiles: modelWeightProfileRepository_1.modelWeightProfileRepository.getAll,
    getLearningAdjustmentLogs: learningAdjustmentLogRepository_1.learningAdjustmentLogRepository.getAll,
    getPromptExperimentRuns: promptExperimentRunRepository_1.promptExperimentRunRepository.getAll,
    getEvaluationMetricLogs: evaluationMetricLogRepository_1.evaluationMetricLogRepository.getAll,
    getAlertOutcomeLogs: alertOutcomeLogRepository_1.alertOutcomeLogRepository.getAll,
    getRecommendationOutcomes: recommendationOutcomeRepository_1.recommendationOutcomeRepository.getAll,
    getMarketSegment: marketSegmentation_1.getMarketSegment,
    aiProviderFactory: aiProviderFactory_1.aiProviderFactory,
    searchProviderFactory: searchProviderFactory_1.searchProviderFactory,
    storageProviderFactory: storageProviderFactory_1.storageProviderFactory,
    monitoringProviderFactory: monitoringProviderFactory_1.monitoringProviderFactory,
    cacheProviderFactory: cacheProviderFactory_1.cacheProviderFactory,
};
