"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeSupplyDemandTrends = computeSupplyDemandTrends;
function computeSupplyDemandTrends(context) {
    // Example: fallback deterministic mock if no data
    if (!context.supplyDemandRaw) {
        return [
            {
                window: "2w",
                activeListingsAvg: 12,
                soldCount: 8,
                soldToListingRatio: 0.67,
                absorptionRate: 0.6,
                newListingVelocity: 2,
                priceTrendPct: 2.5,
                supplyTrendPct: -3.2,
                demandTrendPct: 4.1,
                signal: "Tightening"
            },
            {
                window: "4w",
                activeListingsAvg: 15,
                soldCount: 14,
                soldToListingRatio: 0.93,
                absorptionRate: 0.7,
                newListingVelocity: 3,
                priceTrendPct: 1.2,
                supplyTrendPct: -1.1,
                demandTrendPct: 2.2,
                signal: "Stable"
            },
            {
                window: "3m",
                activeListingsAvg: 18,
                soldCount: 30,
                soldToListingRatio: 1.67,
                absorptionRate: 0.8,
                newListingVelocity: 4,
                priceTrendPct: 0.5,
                supplyTrendPct: 0.0,
                demandTrendPct: 1.0,
                signal: "Flat"
            }
        ];
    }
    // TODO: Real calculation from context.supplyDemandRaw
    return [];
}
