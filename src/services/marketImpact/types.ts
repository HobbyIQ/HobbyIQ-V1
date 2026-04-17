// Shared types for Market Impact Layer

export type MarketImpactSignal = {
  type: string;
  direction: 'positive' | 'negative' | 'neutral';
  score: number; // 0-10
  impactWeight: number; // 0-1
  reason: string;
};

export type AggregatedMarketImpact = {
  overallDirection: 'positive' | 'negative' | 'neutral';
  overallScore: number; // 0-100
  pricePressure: 'upward' | 'downward' | 'neutral';
  marketImpactMultiplierLow: number;
  marketImpactMultiplierHigh: number;
  recentSignals: MarketImpactSignal[];
};
