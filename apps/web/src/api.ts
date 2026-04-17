
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
// import {
//   PortfolioResponse,
//   DecisionResponse,
//   ScarcityResponse,
//   SupplyResponse,
//   GemRateResponse,
// } from "./types";

const API_BASE = `${import.meta.env.VITE_API_BASE_URL}/api`;

export async function fetchPortfolio() {
  const res = await fetch(`${API_BASE}/portfolio`);
  if (!res.ok) throw new Error("Failed to fetch portfolio");
  return res.json();
}

export async function fetchDecision(cardId: string) {
  const res = await fetch(`${API_BASE}/portfolio/${cardId}/decision`);
  if (!res.ok) throw new Error("Failed to fetch decision");
  return res.json();
}

export async function fetchScarcity(cardId: string) {
  const res = await fetch(`${API_BASE}/portfolio/${cardId}/scarcity`);
  if (!res.ok) throw new Error("Failed to fetch scarcity");
  return res.json();
}

export async function fetchSupply(cardId: string) {
  const res = await fetch(`${API_BASE}/portfolio/${cardId}/supply`);
  if (!res.ok) throw new Error("Failed to fetch supply");
  return res.json();
}

export async function fetchGemRate(cardId: string) {
  const res = await fetch(`${API_BASE}/portfolio/${cardId}/gemrate`);
  if (!res.ok) throw new Error("Failed to fetch gem rate");
  return res.json();
}
