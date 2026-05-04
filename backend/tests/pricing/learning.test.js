"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const LearningCalibrationEngine_1 = require("../../src/modules/compiq/services/pricing/learning/LearningCalibrationEngine");
describe('LearningCalibrationEngine', () => {
    it('logs prediction and outcome', () => {
        const pred = {
            id: 'p1',
            cardKey: 'card1',
            predictedFMV: 100,
            predictedQuickSale: 90,
            predictedPremium: 120,
            pricingConfidence: 0.8,
            createdAt: new Date().toISOString()
        };
        const outcome = {
            id: 'o1',
            predictionId: 'p1',
            realizedSalePrice: 110,
            realizedSaleDate: new Date().toISOString(),
            realizedDaysToSell: 5,
            platform: 'ebay',
            auctionOrBin: 'auction'
        };
        LearningCalibrationEngine_1.LearningCalibrationEngine.logPrediction(pred);
        LearningCalibrationEngine_1.LearningCalibrationEngine.logOutcome(outcome);
        expect(LearningCalibrationEngine_1.LearningCalibrationEngine.predictions.length).toBeGreaterThan(0);
        expect(LearningCalibrationEngine_1.LearningCalibrationEngine.outcomes.length).toBeGreaterThan(0);
    });
});
