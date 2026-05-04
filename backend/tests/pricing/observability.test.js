"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const DynamicPricingOrchestrator_1 = require("../../src/modules/compiq/services/pricing/core/DynamicPricingOrchestrator");
// import { MarketContext } from '../../src/modules/compiq/models/intelligence.types';
describe('Observability snapshot', () => {
    it('flags sparse data and fallback', () => {
        const subject = { playerName: 'Test Player', setName: 'Test Set', cardYear: 2020 };
        const comps = [];
        const context = { marketIndexTrend: 0, volatilityIndex: 50 };
        const result = DynamicPricingOrchestrator_1.DynamicPricingOrchestrator.run(subject, comps, context, true);
        expect(result.observability.usedFallback).toBe(true);
        expect(result.observability.sparseDataFlag).toBe(true);
    });
    it('flags non-sparse data', () => {
        const subject = { playerName: 'Test Player', setName: 'Test Set', cardYear: 2020 };
        const comps = [
            { price: 100, date: '2024-01-01', source: 'ebay' },
            { price: 120, date: '2024-01-02', source: 'ebay' },
            { price: 110, date: '2024-01-03', source: 'ebay' },
            { price: 130, date: '2024-01-04', source: 'ebay' }
        ];
        const context = { marketIndexTrend: 1, volatilityIndex: 30 };
        const result = DynamicPricingOrchestrator_1.DynamicPricingOrchestrator.run(subject, comps, context, true);
        expect(result.observability.usedFallback).toBe(false);
        expect(result.observability.sparseDataFlag).toBe(false);
    });
});
