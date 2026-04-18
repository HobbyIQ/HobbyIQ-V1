"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockCompProvider = void 0;
class MockCompProvider {
    async getComps(input) {
        return [
            { date: '2026-04-10', price: 120, grade: 'Raw', source: 'eBay', notes: 'Recent comp' },
            { date: '2026-04-08', price: 110, grade: 'Raw', source: 'eBay', notes: 'Recent comp' },
            { date: '2026-04-05', price: 130, grade: 'Raw', source: 'eBay', notes: 'Recent comp' }
        ];
    }
    estimatePricing(input) {
        return {
            estimatedRaw: 120,
            estimatedPsa10: 300,
            estimatedPsa9: 180,
            estimatedPsa8: 140,
            fairMarketValue: 120,
            compRangeLow: 110,
            compRangeHigh: 130,
            buyTarget: 115
        };
    }
    getPricingSignals(input, fairMarketValue) {
        return ['Good Buy', 'Fair Price'];
    }
    getBullets(input, fairMarketValue) {
        return ['Recent comps support this price.', 'Market is stable.'];
    }
    getNextActions(input, fairMarketValue) {
        return ['Consider buying at or below target.', 'Monitor supply.'];
    }
}
exports.MockCompProvider = MockCompProvider;
