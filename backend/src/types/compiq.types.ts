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
  /**
   * Pin pricing to a specific Cardsight catalog cardId (UUID).
   * Skips text identification — fetchComps routes the pinned-id branch
   * to cardsight.client.getPricing() directly, with client-side grade
   * filtering applied to the response's raw + graded company/grade tree.
   *
   * Renamed from `cardHedgeCardId` as part of CF-PRICE-BY-ID-MIGRATION
   * (first sub-CF of CF-CARDHEDGE-DECOMMISSION-FULL Phase 2). Wire key
   * for `/api/compiq/price-by-id` request body is `cardsightCardId`;
   * the route handler accepts the legacy `cardHedgeCardId` key with a
   * structured warn event during transition (dropped in
   * CF-CARDHEDGE-NAMING-CLEANUP once telemetry confirms zero usage).
   */
  cardsightCardId?: string;
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
