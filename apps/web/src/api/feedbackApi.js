"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendFeedback = sendFeedback;
const api_1 = require("../api");
async function sendFeedback({ query, intent, summary, feedback }) {
    const res = await fetch(`${api_1.API_BASE_URL}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, intent, summary, feedback, timestamp: new Date().toISOString() })
    });
    if (!res.ok)
        throw new Error("Failed to send feedback");
    return res.json();
}
