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
   * Wire key for `/api/compiq/price-by-id` request body is
   * `cardsightCardId` (CardHedge fully decommissioned at 10ad39d).
   */
  cardsightCardId?: string;
}

/**
 * CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): closed source enum for
 * the `source` attribution field on the prediction_log corpus. Every
 * caller of `computeEstimate` must supply one of these literals via the
 * `PredictionCallContext` parameter; `tsc` rejects free strings at
 * compile time so no caller can silently emit "unknown".
 *
 * Naming convention: <subsystem>-<route-or-job>[-<subreason>].
 * Subsystems: "compiq" (free-text + structured price endpoints),
 * "portfolio" (user-initiated holding writes + scheduled reprice),
 * "price-alert-evaluator" (background job).
 *
 * Each value is documented inline with the upstream entry point it
 * attributes to + whether it routes from a portfolio holding (which
 * decides the §4.2/4.3 join-key: routedFromHolding=true rows join to
 * PortfolioLedgerEntry sales via holdingId+userId; routedFromHolding=false
 * rows join to outcomes only via cardsightCardId / the broader
 * eBay-sold path).
 */
export type PredictionCorpusSource =
  /** POST /api/compiq/search — free-text DashboardView search */
  | "compiq-search-freetext"
  /** POST /api/compiq/price — free-text alias of /search */
  | "compiq-price-freetext"
  /** POST /api/compiq/price-by-id — cardsightCardId-pinned price */
  | "compiq-price-by-id"
  /** POST /api/compiq/trendiq — investor+ TrendIQ composite surface */
  | "compiq-trendiq"
  /** POST /api/compiq/trendiq/full — pro_seller TrendIQ L3-full surface */
  | "compiq-trendiq-full"
  /** POST /api/compiq/bulk — per-query in the bulk array */
  | "compiq-bulk-freetext"
  /** POST /api/compiq/grade-premium — fires twice (raw + PSA10) */
  | "compiq-grade-premium"
  /** POST /api/compiq/estimate — structured-input direct estimate */
  | "compiq-estimate-structured"
  /** POST /api/compiq/simulate — what-if exit/hold simulator */
  | "compiq-simulate-whatif"
  /** autoPriceHolding called from addHolding (POST /portfolio/holdings) */
  | "portfolio-autoprice-add"
  /** autoPriceHolding called from updateHolding (PUT/PATCH /portfolio/holdings/:id) */
  | "portfolio-autoprice-update"
  /** autoPriceHolding called from refreshHolding (POST /portfolio/holdings/:id/refresh) */
  | "portfolio-autoprice-refresh"
  /** repriceHoldingsForUser — both scheduled job + manual /reprice/batch */
  | "portfolio-reprice"
  /** runPriceAlertEvaluator background job — no holdingId; PriceAlert
   *  schema has only cardId+userId, no holding linkage. */
  | "price-alert-evaluator"
  /** runAdvancedAlertsEvaluator background job — investor+ rule engine
   *  invokes computeEstimate per scope target (card / player /
   *  watchlist / holdings). holdingId may be set when scope=holdings;
   *  routedFromHolding follows that. */
  | "advanced-alert-evaluator";

/**
 * CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): attribution context
 * threaded from each computeEstimate caller into the corpus emit. These
 * are DESCRIPTIVE/attribution fields — NOT folded into inputSignature
 * (the same card priced from two endpoints is still the same prediction).
 *
 *   - source: REQUIRED, no default. tsc enforces every caller supplies it.
 *   - userId: present iff caller has authenticated upstream context
 *             (portfolio + price-alert paths). Free-text public callers
 *             (compiq-*) pass null.
 *   - holdingId: present iff the call routes from a specific portfolio
 *                holding. Portfolio autoprice + reprice paths set this;
 *                everything else null.
 *   - routedFromHolding: explicit boolean. Defaults false at every caller
 *                        unless that caller's intent is holding-routed
 *                        (the C rule — conservative explicit-opt-in to
 *                        prevent accidental claims). The §4.2/4.3
 *                        sale-join switches on this flag.
 */
export interface PredictionCallContext {
  source: PredictionCorpusSource;
  userId?: string | null;
  holdingId?: string | null;
  routedFromHolding: boolean;
}

export interface CompIQEstimateResponse {
  cardTitle: string;
  verdict: string;
  action: "Buy" | "Hold" | "Sell" | "Pass";
  dealScore: number;
  quickSaleValue: number;
  fairMarketValue: number;
  /**
   * CF-FMV-NOWCAST Ship 1 — per-FMV uncertainty band. Optional + nullable
   * (additive contract): null when fairMarketValue is null/0/NaN. Widens
   * with thin and stale comps; the sibling-pool path starts one band wider.
   * iOS treats unknown / absent as "no band available."
   */
  fairMarketValueLow?: number | null;
  fairMarketValueHigh?: number | null;
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
