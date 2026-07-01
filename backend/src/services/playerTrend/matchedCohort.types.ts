/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * Types for matched-cohort momentum computation.
 *
 * Vs the existing `sales-stats-by-player` weekly average: matched-cohort
 * removes MIX BIAS. Weekly averages swing when the mix of expensive vs
 * cheap cards changes (a Superfractor selling vs not); matched-cohort
 * looks at per-card ratios across cards that sold in BOTH the latest
 * complete week AND the prior 4-week window, then aggregates.
 *
 * Same-store-sales logic. Standard economics move for removing
 * compositional bias from time-series comparisons.
 */

/**
 * Normalized weekly rollup for a single card's sales. Rolled up from
 * whatever daily-series representation the provider returns.
 */
export interface CardWeeklySalesBucket {
  weekStart: string;   // ISO date (Monday)
  weekEnd: string;     // ISO date (Sunday)
  saleCount: number;   // # sales in the week
  medianPrice: number; // median sale price
  meanPrice: number;   // mean sale price (kept for debugging / audit)
}

/**
 * All the weeks of data we have for a single card.
 */
export interface CardWeeklySalesSeries {
  cardId: string;
  /**
   * Grade this series is for. Currently the matched-cohort computation
   * pins to Raw for cross-card comparability; extending to per-grade
   * cohorts is a follow-up.
   */
  grade: string;
  buckets: CardWeeklySalesBucket[];
}

/**
 * Per-card contribution to the matched-cohort. Only cards where BOTH
 * the latest and prior windows had sales appear here.
 */
export interface MatchedCohortMember {
  cardId: string;
  latestWeekMedianPrice: number;
  latestWeekSaleCount: number;
  priorWindowMedianPrice: number;
  priorWindowSaleCount: number;
  /** latest / prior — the per-card ratio contributing to the aggregate. */
  ratio: number;
}

/**
 * Result of the matched-cohort computation for a single player.
 */
export interface MatchedCohortResult {
  latestWeekStart: string;
  latestWeekEnd: string;
  /** How many prior weeks contribute to the "prior" comparison. */
  priorWindowWeeksCount: number;

  /** Cards that had sales in BOTH the latest week AND the prior window. */
  cohort: MatchedCohortMember[];
  /** Median of per-card ratios — the primary output. Null when cohort is empty. */
  medianRatio: number | null;
  /** Mean of per-card ratios — kept for debugging + comparison. */
  meanRatio: number | null;

  /**
   * # unique cards that had ≥1 sale in the latest week. Includes cards
   * that AREN'T in the cohort (because they had no prior-window sales).
   * Rising number = supply/demand thickening; falling = drying up.
   */
  latestWeekActiveCards: number;

  /** Total unique cards we evaluated for this player. */
  totalCardsEvaluated: number;

  /**
   * Diagnostic: how many cards were dropped because they lacked
   * prior-window sales (i.e., appeared in the latest week only —
   * potentially new-to-market or long-tail). Reading this alongside
   * medianRatio gives us confidence in the signal.
   */
  droppedNewOrLongTail: number;
}
