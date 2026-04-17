"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeDecision = makeDecision;
function makeDecision(card) {
    // Mock decision logic: random buy/hold/sell
    const options = ["BUY", "HOLD", "SELL"];
    return {
        cardId: card.id,
        action: options[Math.floor(Math.random() * options.length)],
        reason: "Mock decision for demonstration purposes."
    };
}
