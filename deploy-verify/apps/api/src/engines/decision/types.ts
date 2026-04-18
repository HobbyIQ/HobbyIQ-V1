// Types for the Decision Engine

export type Recommendation = 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';

export interface DecisionEngineInput {
  compIQ: number; // 0-100
  playerIQ: number; // 0-100
  dailyIQ: number; // 0-100
  supplyScore: number; // 0-100
  scarcityScore: number; // 0-100
  liquidityScore: number; // 0-100
  negativePressureScore: number; // 0-100 (higher = more negative pressure)
  pricingTrend: number; // -1 to 1 (normalized)
  // Add more fields as needed
}

export interface DecisionEngineOutput {
  decisionScore: number; // 0-100
  recommendation: Recommendation;
  confidenceScore: number; // 0-100
  targetEntryRange: [number, number];
  targetExit: number;
  holdRange: [number, number];
  urgencyScore: number; // 0-100
  timeHorizon: string; // e.g. 'short', 'medium', 'long'
  explanation: string[];
  majorDrivers: string[];
}
