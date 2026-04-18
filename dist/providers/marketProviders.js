"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBestBuysProvider = getBestBuysProvider;
exports.getMarketMoversProvider = getMarketMoversProvider;
exports.getPlayerSummaryProvider = getPlayerSummaryProvider;
function getBestBuysProvider() {
    return [
        {
            player: 'Josiah Hartshorn',
            card: '2025 Bowman Chrome Gold Shimmer Auto /50',
            recommendation: 'BUY',
            confidence: 88,
            reason: 'Strong upward trend and tightening supply',
            estimatedValue: 392,
            askingPrice: 375
        }
    ];
}
function getMarketMoversProvider() {
    return [
        {
            player: 'Josiah Hartshorn',
            card: '2025 Bowman Chrome Gold Shimmer Auto /50',
            movement: '+8.2%',
            trend: 'up',
            reason: 'Recent comps up, supply down',
            estimatedValue: 392
        }
    ];
}
function getPlayerSummaryProvider(player) {
    return {
        player,
        signal: 'positive',
        recentComps: [
            { date: '2026-04-10', price: 385, grade: 'raw', source: 'eBay', notes: 'clean comp' }
        ],
        supply: {
            active: 21,
            trend2W: -14,
            trend4W: -20,
            trend3M: -8
        },
        news: {
            signal: 'positive',
            impactScore: 70,
            decayDays: 2,
            sourceCount: 3
        }
    };
}
