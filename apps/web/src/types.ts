// Types for Portfolio API
export type PortfolioEntry = {
  id: string;
  player: string;
  card: string;
  year: number;
  team: string;
  grade: string | null;
  value: number;
};

export type PortfolioResponse = {
  portfolio: PortfolioEntry[];
};

export type DecisionResponse = {
  cardId: string;
  action: "BUY" | "HOLD" | "SELL";
  reason: string;
};

export type ScarcityResponse = {
  cardId: string;
  scarcityScore: number;
  notes: string;
};

export type SupplyResponse = {
  cardId: string;
  supply: number;
  notes: string;
};

export type GemRateResponse = {
  cardId: string;
  gemRate: string;
  notes: string;
};
