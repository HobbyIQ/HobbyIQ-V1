// CF-PLAYER-TREND (Drew, 2026-07-17). Types for the matched-cohort
// player-momentum computation over ch_daily_sales. Aggregates same-card
// ratios (not aggregate prices) so a superstar's $M+ superfractor
// can't drown out signal from the player's 100s of common cards.
//
// See [[matched-cohort-supersedes-raw]] — this is the correct
// mechanism for player-momentum signals per the 2026-07-01 Hartman
// case study (raw -8% wrong, matched +36% correct).

/** Individual sale as consumed by the trend computer. */
export interface PlayerSale {
  cardId: string;
  saleDate: string;
  price: number;
  /** Optional label — used only for the perCardRatios[] pretty-print in
   *  the final result. Never affects math. */
  skuLabel?: string | null;
  /** CF-STRATIFIED-TRENDS (Drew, 2026-07-17): grader tier ("Raw", "PSA",
   *  "BGS", "SGC", "CGC", ...). Used to bucket into raw-only vs
   *  graded-only variants of the trend. Optional for back-compat with
   *  older callers; absent → treated as "Raw" for filter purposes. */
  grader?: string | null;
}

/** Options controlling window widths + qualification thresholds. */
export interface PlayerTrendOptions {
  /** Days in the "recent" window. Default 30. */
  recentWindowDays?: number;
  /** Days in the "prior" comparison window, offset to the past. Default 30. */
  priorWindowDays?: number;
  /** Minimum sales in EACH window for a card_id to contribute.
   *  Default 3 — matches the localCompPremiums MIN_BUCKET_N. */
  minSalesPerWindow?: number;
  /** Ignore cards where both windows have < this many total sales.
   *  Default 4. Guards against dead cards flooding the pool. */
  minTotalSales?: number;
  /** Top-N per-card ratios to include in the result. Default 20. */
  topCardsInResult?: number;
  /** CF-STRATIFIED-TRENDS (Drew, 2026-07-17): restrict to raw-only or
   *  graded-only sales. "all" (default) uses every sale. Powers the
   *  raw/graded/all split emitted by the stratified batch. */
  saleFilter?: "all" | "raw_only" | "graded_only";
}

/** Per-card ratio contributing to the aggregate. Sorted by |ratio - 1| DESC
 *  so the biggest movers surface first in the top-N. */
export interface PerCardRatio {
  cardId: string;
  skuLabel: string | null;
  /** median(recent-window prices) / median(prior-window prices) */
  ratio: number;
  nRecent: number;
  nPrior: number;
  medianRecent: number;
  medianPrior: number;
}

/** CF-STRATIFIED-TRENDS (Drew, 2026-07-17): stratified variant emitted
 *  by the nightly compute. `all` is the aggregate signal; `raw` and
 *  `graded` split by grader field so "should I grade this NOW?" can
 *  reason from the direction gap (graded outperforming raw = grade now
 *  signal strengthens). */
export interface StratifiedPlayerTrendResult {
  player: string;
  computedAt: string;
  all: PlayerTrendResult;
  raw: PlayerTrendResult;
  graded: PlayerTrendResult;
}

/** Final result of a per-player matched-cohort computation. */
export interface PlayerTrendResult {
  player: string;
  computedAt: string;

  /** Aggregate player-momentum = mean of per-card ratios (equal weight
   *  per SKU by design — see file header). */
  momentum: number;

  /** Categorical read of `momentum` gated by significance thresholds. */
  direction: "up" | "flat" | "down";

  /** Sales/week across ALL of this player's cards over the recent window.
   *  Not window-widths-adjusted — pure count / (recentWindowDays / 7). */
  velocityPerWeek: number;

  /** Distinct card_ids that had any sales in the pooled window. Not the
   *  same as qualifyingCards — that's the subset that hit minSalesPerWindow
   *  in BOTH windows. */
  cardsInPool: number;

  /** Distinct card_ids that hit the minSalesPerWindow threshold in BOTH
   *  windows — the actual contributors to `momentum`. */
  qualifyingCards: number;

  /** Total sales counted (across all cards, both windows combined). */
  totalSales: number;

  /** Top-N per-card ratios (default 20), sorted by absolute movement so
   *  the biggest movers show first regardless of direction. */
  perCardRatios: PerCardRatio[];

  /** Sanity flags for downstream consumers.
   *   - "sparse": qualifyingCards < 3 — momentum should not be trusted
   *   - "one_card_dominant": top card contributed >50% of total volume
   *   - "wide_ratio_dispersion": stddev(ratios) > 0.5 — signals disagreement
   */
  flags: string[];

  /** Options used for the compute (echoed for downstream introspection). */
  options: Required<PlayerTrendOptions>;
}
