// CF-TIMING-FORECAST (Drew, 2026-07-17). Types for the timing-aware
// 30-days-out price forecast. Combines card-specific regression trend,
// player-level matched-cohort momentum (stratified by raw/graded), and
// velocity into a single actionable number with a confidence tier.
//
// Emitted as the "predicted next-30-days sale price" on card detail
// screens. NOT a substitute for FMV — this is a forecast, not the
// current fair market value.

/** Card-side signals — comes from localCompStore.trend. */
export interface CardTrendInputs {
  /** Line-projected next-sale price (log-price regression). */
  projectedNextSalePrice: number | null;
  /** Log-price slope per day. Positive = up, negative = down. */
  slopePerDay: number;
  /** Std dev of log-price residuals — noise level around the line. */
  volatility: number;
  /** Number of comps in the window used to fit the trend. */
  windowSales: number;
  /** Latest observed sale price — used as a floor when trend can't project. */
  latestPrice: number | null;
}

/** Player-side signals — from playerTrendStore (stratified). */
export interface PlayerTrendInputs {
  /** Matched-cohort momentum across all sales (unfiltered). */
  allMomentum: number;
  /** Matched-cohort momentum on raw sales only. */
  rawMomentum: number | null;
  /** Matched-cohort momentum on graded sales only. */
  gradedMomentum: number | null;
  /** Player-level sales/week (velocity baseline for the current SKU). */
  playerVelocityPerWeek: number;
  /** Diagnostic flags — carried through so timing-aware can attenuate
   *  confidence when data is sparse. */
  playerFlags: string[];
}

/** Input to the pure forecast math. */
export interface TimingForecastInputs {
  cardTrend: CardTrendInputs | null;
  playerTrend: PlayerTrendInputs | null;
  /** SKU velocity — used vs playerVelocityPerWeek to classify hot/cold. */
  skuVelocityPerWeek: number;
  /** "Raw" | "PSA 10" | ... — drives which player-trend variant to weight. */
  currentGraderTier: string;
  /** Days ahead to forecast. Default 30. */
  horizonDays?: number;
}

/** Emitted forecast. */
export interface TimingForecastResult {
  predictedPrice: number;
  priceRange: { low: number; high: number };
  confidence: "high" | "medium" | "low" | "insufficient";
  horizonDays: number;
  contributingSignals: {
    /** Card-side slope translated to %/month for human display. */
    cardTrendSlopePerMonthPct: number | null;
    /** Momentum selected for the price adjustment (raw for raw
     *  holdings, graded for graded holdings, all as fallback). */
    playerMomentumUsed: number | null;
    /** Which stratified variant contributed the momentum. */
    playerMomentumSource: "raw" | "graded" | "all" | "none";
    /** Velocity classification. */
    velocitySignal: "hot" | "normal" | "cold" | "unknown";
    /** Volatility from the trend fit, echoed for downstream. */
    volatility: number | null;
    /** Sample size the card-side trend used. */
    windowSales: number | null;
  };
  reason: string;
}
