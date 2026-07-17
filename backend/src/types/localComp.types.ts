// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Types for the own-corpus
// comp lookup — reads ch_daily_sales (886k+ baseball sales), returns
// comps + trend + observed premium curves. Replaces per-query CH API
// as the first-check comp source; CH-per-query becomes secondary,
// Cardsight tertiary.

/** Structured key to look up comps by. Either `cardId` OR structured
 *  attrs; when both are provided cardId wins (cheaper single-partition
 *  read).
 *
 *  Field-mapping note (2026-07-17, fix/local-comps-schema-match): the
 *  Cardsight-router `identity.product` and `identity.parallel` don't
 *  string-equal ch_daily_sales's `card_set` / `variant` (identity
 *  gives "Bowman Chrome"; ch_daily_sales stores "2026 Bowman Baseball"
 *  in card_set and "Base" in variant). So the strong structured
 *  identity is (player + year + number), which round-trips cleanly.
 *  cardSet/variant remain in the key for CLI + test coverage but the
 *  router-caller should prefer the strong triple. */
export interface LocalCompLookupKey {
  cardId?: string;
  player?: string;
  year?: number;
  cardSet?: string;
  variant?: string;
  number?: string;
  grade?: string;
  grader?: string;
  /** When true, don't filter by grader/grade — return every sale for
   *  the SKU regardless of graded state. Used for grader-premium math. */
  allGrades?: boolean;
}

/** Options controlling the trend window + result caps. */
export interface LocalCompOptions {
  /** Days of history to include in trend math. Default 90. */
  trendWindowDays?: number;
  /** Maximum recent sales to return in the response. Default 20. */
  recentSalesLimit?: number;
  /** Skip grader/parallel premium computation (faster). Default false. */
  skipPremiums?: boolean;
}

/** Individual sale record surfaced to callers. Subset of CHDailySaleRow. */
export interface LocalCompSale {
  priceHistoryId: string;
  cardId: string;
  saleDate: string;
  price: number;
  grade: string;
  grader: string;
  variant: string;
  saleType: string;
  imageUrl: string;
  listingUrl: string;
  description: string;
}

/** Result of a single-SKU comp lookup. */
export interface LocalCompResult {
  /** The key we ran with (echoed for callsites doing multi-lookup). */
  lookupKey: LocalCompLookupKey;
  /** Total matching rows for the SKU key (across all history in-container). */
  totalSales: number;
  /** Total matching rows within trendWindowDays. */
  windowSales: number;
  /** Most recent N sales (default 20), sorted date DESC. */
  recentSales: LocalCompSale[];
  /** Trend numbers computed on `windowSales`. Null when window empty. */
  trend: LocalCompTrend | null;
  /** Grader premium curve (relative to Raw baseline). Empty when only one
   *  grader present or skipPremiums=true. */
  graderPremiums: Record<string, LocalCompPremium>;
  /** Parallel premium curve (relative to Base variant). Empty when only
   *  one variant present or skipPremiums=true. */
  parallelPremiums: Record<string, LocalCompPremium>;
  /** Diagnostic — RUs consumed on the query. */
  diagnostics: {
    ruCharge: number;
    queryMs: number;
    partitionKey: "cardId" | "cross";
  };
}

export interface LocalCompTrend {
  windowDays: number;
  /** Linear regression slope in log-price / day. Positive = up, negative = down. */
  slope: number;
  /** Categorical read of `slope` gated by significance. */
  momentum: "up" | "flat" | "down";
  /** Sales per week over the window (windowSales * 7 / windowDays). */
  velocityPerWeek: number;
  /** Std dev of log-price residuals — noise level around the trend line. */
  volatility: number;
  /** Predicted next-sale price from the fitted line (never a mean/median). */
  projectedNextSalePrice: number | null;
  /** Anchor points for the trend line — [earliestDate, projectedNext] */
  earliestPrice: number | null;
  latestPrice: number | null;
}

export interface LocalCompPremium {
  /** Number of comps in this bucket. */
  n: number;
  /** Mean sale price for the bucket. Never used as FMV — descriptive only. */
  meanPrice: number;
  /** Multiplier vs baseline (Raw for grader curve, Base for parallel curve). */
  multiplierVsBaseline: number;
}
