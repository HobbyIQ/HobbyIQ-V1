"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const DynamicPricingOrchestrator_1 = require("../../src/modules/compiq/services/pricing/core/DynamicPricingOrchestrator");
// import { MarketContext } from '../../src/modules/compiq/models/intelligence.types';
describe('Pipeline fallbacks', () => {
    it('returns fallback for empty comps', () => {
        const subject = { playerName: 'T', setName: 'S', cardYear: 2020 };
        const comps = [];
        const context = { marketIndexTrend: 0, volatilityIndex: 50 };
        const result = DynamicPricingOrchestrator_1.DynamicPricingOrchestrator.run(subject, comps, context, true);
        expect(result.priceLanes.fairMarketValue).toBe(0);
        expect(result.observability.usedFallback).toBe(true);
        expect(result.observability.fallbackReason).toBeDefined();
    });
    it('returns fallback for all rejected comps', () => {
        // Simulate all comps rejected by setting a rejectionReason
        const subject = { playerName: 'T', setName: 'S', cardYear: 2020 };
        const comps = [
            { price: 0, date: '2024-01-01', source: 'ebay' }
        ];
        const context = { marketIndexTrend: 0, volatilityIndex: 50 };
        const result = DynamicPricingOrchestrator_1.DynamicPricingOrchestrator.run(subject, comps, context, true);
        expect(result.priceLanes.fairMarketValue).toBe(0);
        expect(result.observability.usedFallback).toBe(true);
    });
});
