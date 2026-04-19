"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockRecommendationOutcomes = exports.mockAlertOutcomeLogs = exports.mockEvaluationMetricLogs = exports.mockPromptExperimentRuns = exports.mockLearningAdjustmentLogs = exports.mockPricingOutcomes = exports.mockPricingSnapshots = exports.mockWeightProfiles = void 0;
// src/data/mockLearning.ts
const uuid_1 = require("uuid");
exports.mockWeightProfiles = [
    {
        id: (0, uuid_1.v4)(),
        marketSegment: "psa10_base",
        weights: {
            recencyWeight: 0.25,
            exactGradeWeight: 0.2,
            exactParallelWeight: 0.1,
            sameSetWeight: 0.1,
            autoMatchWeight: 0.1,
            saleTypeAuctionWeight: 0.1,
            saleTypeBinWeight: 0.05,
            acceptedOfferWeight: 0.05,
            outlierPenaltyWeight: 0.05,
            liquidityAdjustmentWeight: 0.05,
            scarcityAdjustmentWeight: 0.05,
            volatilityPenaltyWeight: 0.05,
        },
        version: "v1.0.0",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
        approved: true,
    },
    {
        id: (0, uuid_1.v4)(),
        marketSegment: "raw_base",
        weights: {
            recencyWeight: 0.3,
            exactGradeWeight: 0.1,
            exactParallelWeight: 0.05,
            sameSetWeight: 0.1,
            autoMatchWeight: 0.05,
            saleTypeAuctionWeight: 0.15,
            saleTypeBinWeight: 0.1,
            acceptedOfferWeight: 0.05,
            outlierPenaltyWeight: 0.1,
            liquidityAdjustmentWeight: 0.05,
            scarcityAdjustmentWeight: 0.05,
            volatilityPenaltyWeight: 0.05,
        },
        version: "v1.0.0",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
        approved: true,
    },
];
exports.mockPricingSnapshots = [
    {
        id: (0, uuid_1.v4)(),
        cardId: "card1",
        playerId: "player1",
        marketSegment: "psa10_base",
        fmvEstimate: 120,
        buyTarget: 110,
        sellTarget: 130,
        confidenceScore: 85,
        compSet: ["comp1", "comp2", "comp3"],
        weightsUsed: exports.mockWeightProfiles[0],
        recommendation: "Strong Buy",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    },
    {
        id: (0, uuid_1.v4)(),
        cardId: "card2",
        playerId: "player2",
        marketSegment: "raw_base",
        fmvEstimate: 30,
        buyTarget: 25,
        sellTarget: 35,
        confidenceScore: 70,
        compSet: ["comp4", "comp5"],
        weightsUsed: exports.mockWeightProfiles[1],
        recommendation: "Hold",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    },
];
exports.mockPricingOutcomes = [
    {
        id: (0, uuid_1.v4)(),
        snapshotId: exports.mockPricingSnapshots[0].id,
        cardId: "card1",
        actualSalePrice: 125,
        actualDaysToSell: 3,
        saleType: "auction",
        acceptedOffer: undefined,
        outcomeDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4).toISOString(),
        direction: "accurate",
    },
    {
        id: (0, uuid_1.v4)(),
        snapshotId: exports.mockPricingSnapshots[1].id,
        cardId: "card2",
        actualSalePrice: 28,
        actualDaysToSell: 7,
        saleType: "bin",
        acceptedOffer: undefined,
        outcomeDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
        direction: "underpriced",
    },
];
exports.mockLearningAdjustmentLogs = [
    {
        id: (0, uuid_1.v4)(),
        marketSegment: "psa10_base",
        priorProfileId: exports.mockWeightProfiles[0].id,
        newProfileId: (0, uuid_1.v4)(),
        adjustment: {
            recencyWeight: 0.27,
            exactGradeWeight: 0.19,
            exactParallelWeight: 0.11,
            sameSetWeight: 0.1,
            autoMatchWeight: 0.1,
            saleTypeAuctionWeight: 0.1,
            saleTypeBinWeight: 0.05,
            acceptedOfferWeight: 0.05,
            outlierPenaltyWeight: 0.05,
            liquidityAdjustmentWeight: 0.05,
            scarcityAdjustmentWeight: 0.05,
            volatilityPenaltyWeight: 0.05,
        },
        explanation: "Slightly increased recency and parallel weights based on last 30 days accuracy.",
        sampleSize: 28,
        accuracyBefore: 0.82,
        accuracyAfter: 0.85,
        dryRun: false,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    },
];
exports.mockPromptExperimentRuns = [
    {
        id: (0, uuid_1.v4)(),
        promptVersion: "v1.0.0",
        status: "completed",
        startedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
        completedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
        metrics: [],
        providerMode: "mock",
    },
];
exports.mockEvaluationMetricLogs = [
    {
        id: (0, uuid_1.v4)(),
        experimentId: exports.mockPromptExperimentRuns[0].id,
        metric: "coherence",
        value: 0.9,
        source: "mock",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    },
];
exports.mockAlertOutcomeLogs = [
    {
        id: (0, uuid_1.v4)(),
        alertId: "alert1",
        userId: "user1",
        outcome: "action_taken",
        triggeredAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
        resolvedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
        effectiveness: "high",
    },
];
exports.mockRecommendationOutcomes = [
    {
        id: (0, uuid_1.v4)(),
        recommendationId: "rec1",
        userId: "user1",
        result: "good",
        observedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    },
];
