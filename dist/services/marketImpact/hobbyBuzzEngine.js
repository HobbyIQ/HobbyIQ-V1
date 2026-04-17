"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHobbyBuzzImpact = getHobbyBuzzImpact;
function getHobbyBuzzImpact(buzzData) {
    if (!buzzData) {
        return {
            type: 'hobby_buzz_neutral',
            direction: 'neutral',
            score: 0,
            impactWeight: 0,
            reason: 'No hobby buzz data',
        };
    }
    if (buzzData.supplyTightening) {
        return {
            type: 'supply_tightening',
            direction: 'positive',
            score: 6,
            impactWeight: 0.5,
            reason: 'Supply tightening detected',
        };
    }
    if (buzzData.supplyExpanding) {
        return {
            type: 'supply_expanding',
            direction: 'negative',
            score: 5,
            impactWeight: 0.4,
            reason: 'Supply expanding detected',
        };
    }
    if (buzzData.hypeSpike) {
        return {
            type: 'hobby_buzz_up',
            direction: 'positive',
            score: 8,
            impactWeight: 0.7,
            reason: 'Hobby hype spike detected',
        };
    }
    if (buzzData.hobbyBuzzDown) {
        return {
            type: 'hobby_buzz_down',
            direction: 'negative',
            score: 5,
            impactWeight: 0.4,
            reason: 'Hobby buzz cooling off',
        };
    }
    return {
        type: 'hobby_buzz_neutral',
        direction: 'neutral',
        score: 2,
        impactWeight: 0.2,
        reason: 'No significant hobby buzz',
    };
}
