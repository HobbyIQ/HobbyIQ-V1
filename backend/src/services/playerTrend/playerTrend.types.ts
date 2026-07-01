/**
 * CF-PLAYER-MOMENTUM-THIN-COMP-PROJECTION (2026-07-01):
 * Vendor-neutral types for player-level sales trend data.
 *
 * The engine consumes these shapes; providers (CardHedge today, eBay-
 * direct tomorrow) adapt their native responses into these shapes at
 * the boundary. Downstream code stays vendor-agnostic — only the
 * provider file changes when we switch data sources.
 */

/**
 * A single weekly sales aggregate for a player, normalized from whatever
 * shape the underlying provider returns. Complete weeks only — providers
 * flag partial-week buckets on the boundary and this layer filters them.
 */
export interface NormalizedWeeklySales {
  /** ISO 8601 date of the Monday that starts this week. */
  weekStart: string;
  /** ISO 8601 date of the Sunday that ends this week. */
  weekEnd: string;
  /** Number of sales in the week (all cards, all grades, all parallels). */
  count: number;
  /** Total dollars transacted in the week. */
  totalDollars: number;
  /** Mean sale price for the week. When count === 0, avgSale is 0. */
  avgSale: number;
}

/**
 * Momentum signal derived from N weeks of NormalizedWeeklySales.
 * Ratios are `latest / prior_mean` — 1.0 means flat, > 1.0 = up, < 1.0 = down.
 * Nulls when there isn't enough history to compute.
 */
export interface PlayerMomentumSignal {
  /** The most recent COMPLETE week (partial current-week bucket excluded). */
  latestCompleteWeek: NormalizedWeeklySales | null;
  /** Mean of prior N weeks' `avgSale` (excluding the latest). */
  priorMeanAvgSale: number | null;
  /** Mean of prior N weeks' `count`. */
  priorMeanCount: number | null;
  /** How many prior weeks contributed to the mean (typically 4). */
  priorWeeksCount: number;
  /** `latest.avgSale / priorMeanAvgSale`. Null when priorMeanAvgSale is 0. */
  momentumRatio: number | null;
  /** `latest.count / priorMeanCount`. Null when priorMeanCount is 0. */
  volumeRatio: number | null;
}

/**
 * Full trend snapshot for a player — momentum + 30d cumulative volume +
 * supply-trend classification + optional matched-cohort momentum.
 * Callers of `getPlayerTrendSnapshot` receive this or null.
 */
export interface PlayerTrendSnapshot {
  /** Player name as queried; provider may canonicalize but downstream uses this. */
  player: string;
  /** Derived momentum signal from the weekly buckets. */
  momentum: PlayerMomentumSignal;
  /**
   * Leading-indicator classification derived from the momentum + volume
   * ratios. See `supplyTrend.classify.ts` for the 4-quadrant matrix.
   * `flat` when either ratio is null or below the meaningful-deviation
   * threshold.
   */
  supplyTrend: SupplyTrendClassification;
  /** Total sales count for this player over the last 30 days. */
  totalSales30d: number | null;
  /**
   * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01): mix-bias-free
   * momentum derived from per-card ratios across cards that sold in
   * BOTH the latest week AND the prior 4-week window. Present when a
   * background job has populated the matched-cohort cache for this
   * player within the last 48h; null otherwise. When present, this is
   * the SUPERIOR signal to `momentum.momentumRatio` — downstream should
   * prefer this ratio for pricing decisions and only fall back to the
   * raw weekly average when null.
   */
  matchedCohort: PlayerMatchedCohortSummary | null;
  /** Provider that produced this snapshot (for telemetry + rollback). */
  providerName: string;
  /** Unix ms when the snapshot was captured. Nulls if provider doesn't stamp. */
  capturedAtMs: number;
}

/**
 * Compact summary of matched-cohort momentum surfaced on the snapshot.
 * Full detail (per-card ratios) is available in the cache; this shape
 * is what runtime code needs.
 */
export interface PlayerMatchedCohortSummary {
  /** Median of per-card ratios across the cohort. Primary signal. */
  medianRatio: number;
  /** Mean of per-card ratios. Kept for debugging + comparison. */
  meanRatio: number;
  /** How many cards contributed to the cohort. */
  cohortSize: number;
  /** How many cards had ≥1 sale in the latest week (superset of cohort). */
  latestWeekActiveCards: number;
  /** Latest week's Monday date. */
  latestWeekStart: string;
  /** How many prior weeks contributed to the "prior" comparison. */
  priorWindowWeeksCount: number;
  /** Unix ms when the matched-cohort was computed (cache hit time). */
  computedAtMs: number;
}

export type SupplyTrendClassification =
  | "demand_growth"
  | "supply_dry"
  | "supply_flood"
  | "demand_crash"
  | "flat";

/**
 * Provider abstraction. Any implementation adapts the underlying vendor's
 * API into these shapes at the boundary. This is the ONLY interface
 * downstream code depends on for player-trend data.
 */
export interface PlayerTrendProvider {
  /** Short identifier used in telemetry (`cardhedge`, `ebay-direct`, etc.). */
  readonly name: string;

  /**
   * Fetch the last N complete weeks + current partial for a player, plus
   * the 30d cumulative count. Returns null when the provider has no data
   * OR the provider isn't configured (missing env, missing auth, etc.) —
   * callers must treat null as "no signal available" and skip projection.
   */
  getPlayerTrendSnapshot(playerName: string, weeksBack: number): Promise<PlayerTrendSnapshot | null>;
}
