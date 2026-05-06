import { API_BASE_URL, apiFetch } from "./api/client";

export { API_BASE_URL };
// import {
//   PortfolioResponse,
//   DecisionResponse,
//   ScarcityResponse,
//   SupplyResponse,
//   GemRateResponse,
// } from "./types";

const API_BASE = "/api";

export async function fetchPortfolio() {
  return apiFetch(`${API_BASE}/portfolio`, { auth: true });
}

export async function fetchDecision(cardId: string) {
  return apiFetch(`${API_BASE}/portfolio/${cardId}/decision`, { auth: true });
}

export async function fetchScarcity(cardId: string) {
  return apiFetch(`${API_BASE}/portfolio/${cardId}/scarcity`, { auth: true });
}

export async function fetchSupply(cardId: string) {
  return apiFetch(`${API_BASE}/portfolio/${cardId}/supply`, { auth: true });
}

export async function fetchGemRate(cardId: string) {
  return apiFetch(`${API_BASE}/portfolio/${cardId}/gemrate`, { auth: true });
}
