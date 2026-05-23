export interface CompIQEstimateRequest {
  playerName?: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  /**
   * Phase 2 v2 — defect #11: cardNumber propagated from parsed query (set by
   * `requestFromParsed` in compiq.routes.ts) so it can reach `resolveCardId`
   * via queryContext for cardNumber detail-probe disambiguation AND so the
   * LRU cache key correctly includes it. iOS clients calling /estimate may
   * also pass it directly.
   */
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: number;
  isAuto?: boolean;
  /** Pin pricing to a specific Card Hedge card_id (skips text identification). */
  cardHedgeCardId?: string;
}

export interface CompIQEstimateResponse {
  cardTitle: string;
  verdict: string;
  action: "Buy" | "Hold" | "Sell" | "Pass";
  dealScore: number;
  quickSaleValue: number;
  fairMarketValue: number;
  premiumValue: number;
  explanation: string[];
  marketDNA: {
    demand: "High" | "Medium" | "Low";
    speed: "Fast" | "Normal" | "Slow";
    risk: "Low" | "Medium" | "High";
    trend: "Up" | "Flat" | "Down";
  };
  confidence: {
    pricingConfidence: number;
    liquidityConfidence: number;
    timingConfidence: number;
  };
  exitStrategy: {
    recommendedMethod: "auction" | "bin";
    expectedDaysToSell: number | null;
    timingRecommendation: string;
  };
  freshness: {
    status: "Live" | "Updated today" | "Yesterday" | "Needs refresh";
    lastUpdated: string | null;
  };
}
