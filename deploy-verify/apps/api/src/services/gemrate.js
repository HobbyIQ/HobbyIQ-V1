"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGemRate = getGemRate;
function getGemRate(card) {
    // Mock gem rate: random value
    return {
        cardId: card.id,
        gemRate: Math.random().toFixed(2),
        notes: "Mock gem rate value."
    };
}
