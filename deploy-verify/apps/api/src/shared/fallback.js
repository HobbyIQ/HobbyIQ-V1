"use strict";
// Fallback + Mock Handling for HobbyIQ
Object.defineProperty(exports, "__esModule", { value: true });
exports.fallbackResponse = fallbackResponse;
function fallbackResponse(message, data = {}) {
    return {
        fallback: true,
        message,
        ...data
    };
}
