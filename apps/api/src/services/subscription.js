"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSubscription = getSubscription;
exports.validateAppleReceipt = validateAppleReceipt;
// Mock subscription service for HobbyIQ
function getSubscription(userId) {
    // Return mock subscription data
    return {
        userId,
        plan: "Dealer Pro",
        valid: true
    };
}
async function validateAppleReceipt(receipt) {
    // Always return true in mock mode
    return true;
}
