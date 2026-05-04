"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const DynamicPricingOrchestrator_1 = require("../../src/modules/compiq/services/pricing/core/DynamicPricingOrchestrator");
// import { MarketContext } from '../../src/modules/compiq/models/intelligence.types';
describe('DynamicPricingOrchestrator', () => {
    it('returns fallback when no comps', () => {
        const subject = { playerName: 'Test Player', setName: 'Test Set', cardYear: 2020 };
        const comps = [];
        const context = { marketIndexTrend: 0, volatilityIndex: 50 };
        const result = DynamicPricingOrchestrator_1.DynamicPricingOrchestrator.run(subject, comps, context, true);
        expect(result.priceLanes.fairMarketValue).toBe(0);
        expect(result.observability.usedFallback).toBe(true);
    });
    it('returns valid output for basic comps', () => {
        const subject = { playerName: 'Test Player', setName: 'Test Set', cardYear: 2020 };
        const comps = [
            { price: 100, date: '2024-01-01', source: 'ebay' },
            { price: 120, date: '2024-01-02', source: 'ebay' }
        ];
        const context = { marketIndexTrend: 1, volatilityIndex: 30 };
        const result = DynamicPricingOrchestrator_1.DynamicPricingOrchestrator.run(subject, comps, context, true);
        expect(result.priceLanes.fairMarketValue).toBeGreaterThan(0);
        expect(result.observability.usedFallback).toBe(false);
        expect(result.compSummary.length).toBeGreaterThan(0);
    });
});
