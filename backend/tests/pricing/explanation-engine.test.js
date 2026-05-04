"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ExplanationEngine_1 = require("../../src/modules/compiq/services/verdict/ExplanationEngine");
describe('ExplanationEngine', () => {
    it('generates fast market and high demand bullets', () => {
        const result = ExplanationEngine_1.ExplanationEngine.generate({
            market: { marketSpeed: 'fast' },
            marketDNA: { demand: 'high', risk: 'medium' },
            dealScore: 95,
            priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
            confidence: { pricingConfidence: 0.9 },
            alerts: ['Test alert'],
            compSummary: ['c1', 'c2']
        });
        expect(result).toContain('Recent sales happened quickly.');
        expect(result).toContain('There are not many listed right now.');
    });
    it('generates slow market and low demand bullets', () => {
        const result = ExplanationEngine_1.ExplanationEngine.generate({
            market: { marketSpeed: 'slow' },
            marketDNA: { demand: 'low', risk: 'high' },
            dealScore: 40,
            priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
            confidence: { pricingConfidence: 0.4 },
            alerts: ['Test alert'],
            compSummary: ['c1', 'c2']
        });
        expect(result).toContain('Market is moving slowly.');
        expect(result).toContain('Supply is high for this card.');
        expect(result).toContain('This card may be overpriced.');
        expect(result).toContain('Risk is higher right now.');
        expect(result).toContain('Confidence is lower due to limited data.');
    });
});
