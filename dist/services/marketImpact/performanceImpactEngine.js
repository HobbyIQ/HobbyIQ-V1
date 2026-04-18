"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPerformanceImpact = getPerformanceImpact;
function getPerformanceImpact(stats) {
    if (!stats) {
        return {
            type: 'performance_hot',
            direction: 'neutral',
            score: 0,
            impactWeight: 0,
            reason: 'No recent performance data',
        };
    }
    if (stats.recentGames && stats.recentGames > 5 && stats.avgPoints > 20) {
        return {
            type: 'performance_hot',
            direction: 'positive',
            score: 8,
            impactWeight: 0.7,
            reason: 'Player on a hot streak',
        };
    }
    if (stats.recentGames && stats.recentGames > 5 && stats.avgPoints < 8) {
        return {
            type: 'performance_cold',
            direction: 'negative',
            score: 7,
            impactWeight: 0.6,
            reason: 'Player on a cold streak',
        };
    }
    return {
        type: 'performance_neutral',
        direction: 'neutral',
        score: 3,
        impactWeight: 0.2,
        reason: 'Average recent performance',
    };
}
