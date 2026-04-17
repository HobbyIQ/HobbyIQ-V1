"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateScarcity = calculateScarcity;
// In future: use a real provider abstraction for scarcity
function calculateScarcity(card) {
    // Mock scarcity: random value
    return {
        cardId: card.id,
        scarcityScore: Math.floor(Math.random() * 100),
        notes: "Mock scarcity score."
    };
}
// TODO: Azure Functions/cron integration point for scheduled scarcity refresh
