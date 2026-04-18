"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAbsorptionAnalysis = getAbsorptionAnalysis;
function getAbsorptionAnalysis(listings, sold7d, newListings7d) {
    if (!newListings7d || newListings7d === 0) {
        return {
            absorptionRate: null,
            liquidityScore: 0,
            supplyPressure: 'neutral',
            notes: ['No new listings data']
        };
    }
    const absorptionRate = sold7d / newListings7d;
    let liquidityScore = Math.min(1, absorptionRate);
    let supplyPressure = 'neutral';
    let notes = [];
    if (absorptionRate > 1.2) {
        supplyPressure = 'tightening';
        notes.push('Demand outpacing new supply');
    }
    else if (absorptionRate < 0.7) {
        supplyPressure = 'expanding';
        notes.push('Supply outpacing demand');
    }
    else {
        notes.push('Supply and demand balanced');
    }
    return { absorptionRate, liquidityScore, supplyPressure, notes };
}
