"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.API_BASE_URL = void 0;
exports.fetchPortfolio = fetchPortfolio;
exports.fetchDecision = fetchDecision;
exports.fetchScarcity = fetchScarcity;
exports.fetchSupply = fetchSupply;
exports.fetchGemRate = fetchGemRate;
exports.API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
// import {
//   PortfolioResponse,
//   DecisionResponse,
//   ScarcityResponse,
//   SupplyResponse,
//   GemRateResponse,
// } from "./types";
const API_BASE = `${import.meta.env.VITE_API_BASE_URL}/api`;
async function fetchPortfolio() {
    const res = await fetch(`${API_BASE}/portfolio`);
    if (!res.ok)
        throw new Error("Failed to fetch portfolio");
    return res.json();
}
async function fetchDecision(cardId) {
    const res = await fetch(`${API_BASE}/portfolio/${cardId}/decision`);
    if (!res.ok)
        throw new Error("Failed to fetch decision");
    return res.json();
}
async function fetchScarcity(cardId) {
    const res = await fetch(`${API_BASE}/portfolio/${cardId}/scarcity`);
    if (!res.ok)
        throw new Error("Failed to fetch scarcity");
    return res.json();
}
async function fetchSupply(cardId) {
    const res = await fetch(`${API_BASE}/portfolio/${cardId}/supply`);
    if (!res.ok)
        throw new Error("Failed to fetch supply");
    return res.json();
}
async function fetchGemRate(cardId) {
    const res = await fetch(`${API_BASE}/portfolio/${cardId}/gemrate`);
    if (!res.ok)
        throw new Error("Failed to fetch gem rate");
    return res.json();
}
