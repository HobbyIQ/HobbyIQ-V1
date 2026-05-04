import { LearningCalibrationEngine } from '../../src/modules/compiq/services/pricing/learning/LearningCalibrationEngine.js';
import { expect } from 'chai';

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
    LearningCalibrationEngine.logPrediction(pred);
    LearningCalibrationEngine.logOutcome(outcome);
    expect(LearningCalibrationEngine.predictions.length).to.be.greaterThan(0);
    expect(LearningCalibrationEngine.outcomes.length).to.be.greaterThan(0);
  });
});
