"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAwardsImpact = getAwardsImpact;
function getAwardsImpact(awardsData) {
    if (!awardsData || !awardsData.recentAwards) {
        return {
            type: 'award',
            direction: 'neutral',
            score: 0,
            impactWeight: 0,
            reason: 'No recent awards',
        };
    }
    if (awardsData.recentAwards.length > 0) {
        return {
            type: 'award',
            direction: 'positive',
            score: 7,
            impactWeight: 0.6,
            reason: `Recent award(s): ${awardsData.recentAwards.join(', ')}`,
        };
    }
    return {
        type: 'award',
        direction: 'neutral',
        score: 2,
        impactWeight: 0.2,
        reason: 'No significant recent awards',
    };
}
