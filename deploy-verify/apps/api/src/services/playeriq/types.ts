// Strongly typed request and response models for PlayerIQ

export interface PlayerIQRequest {
  player: string;
  organization?: string;
  level?: string;
}

// Card Price Intelligence
export interface CardMarketSnapshot {
  keyCardPrices: Record<string, number>;
  baseAutoRaw?: number | null;
  baseAutoPsa10?: number | null;
  refractorAutoRaw?: number | null;
  colorHighlights?: string[];
  marketTrend?: string;
  marketSummary?: string;
}

// Top Gem-Rate Cards
export interface TopGemRateCard {
  cardName: string;
  parallel: string;
  estimatedGemRate: number;
  populationSignal: string;
  scarcitySignal: string;
  gradingRecommendation: string;
}

export interface PlayerIQResponse {
  success: boolean;
  player: string;
  organization: string | null;
  level: string | null;
  overallScore: number;
  talentScore: number;
  marketScore: number;
  riskScore: number;
  riskLabel: string;
  summary: string;
  strengths: string[];
  risks: string[];
  recommendation: string;
  confidence: number;
  cardMarketSnapshot: CardMarketSnapshot;
  topGemRateCards: TopGemRateCard[];
  warnings: string[];
  nextActions: string[];
}
