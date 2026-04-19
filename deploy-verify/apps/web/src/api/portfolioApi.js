"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveToPortfolio = saveToPortfolio;
const api_1 = require("../api");
async function saveToPortfolio({ player, description, estimatedValue }) {
    const res = await fetch(`${api_1.API_BASE_URL}/api/portfolio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player, description, estimatedValue })
    });
    if (!res.ok)
        throw new Error("Failed to save to portfolio");
    return res.json();
}
