"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePortfolioAddRequest = validatePortfolioAddRequest;
exports.validateCompIQRequest = validateCompIQRequest;
exports.validatePlayerIQRequest = validatePlayerIQRequest;
function validatePortfolioAddRequest(input) {
    if (!input || typeof input.cardTitle !== "string" || !input.cardTitle.trim()) {
        throw new Error("Invalid request: 'cardTitle' is required.");
    }
    if (typeof input.quantity !== "number" || input.quantity <= 0) {
        throw new Error("Invalid request: 'quantity' must be a positive number.");
    }
    if (typeof input.costBasis !== "number" || input.costBasis < 0) {
        throw new Error("Invalid request: 'costBasis' must be a non-negative number.");
    }
}
function validateCompIQRequest(input) {
    if (!input || typeof input.query !== "string" || !input.query.trim()) {
        throw new Error("Invalid request: 'query' is required.");
    }
}
function validatePlayerIQRequest(input) {
    if (!input || typeof input.player !== "string" || !input.player.trim()) {
        throw new Error("Invalid request: 'player' is required.");
    }
}
