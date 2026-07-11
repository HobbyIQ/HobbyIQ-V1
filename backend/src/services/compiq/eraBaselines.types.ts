// CF-NO-NULL-PRICING (2026-07-11, Drew — PR 2 types, revised in PR 4).
//
// Cosmos container `era-baselines` stores FORWARD-LOOKING pricing
// summaries per (productKey, year, cardClass). Not median-of-past;
// instead, a recency-weighted CURRENT value + a 7-day PREDICTED value.
// Refreshed by a daily background job (PR 4).
//
// Why not median: pricing decisions need "what is this worth right now"
// and "where is it going" — same shape as the top-level estimate
// response (fairMarketValue + predictedPrice). Medians of past sales
// are inputs, not outputs; storing them at rest would force Tier 6 to
// re-do the trend math on every lookup.
//
// Consumed by Tier 6 (referenceCatalogBaseline) as the PRIMARY source
// when the container is populated; falls back to the hand-curated
// static table when the container is empty or the specific tuple is
// missing.

export const ERA_BASELINE_SCHEMA_VERSION = 2;

/** Autograph vs raw base — same discriminator the ladder uses. */
export type CardClass = "auto" | "base";

/** Trend direction, same taxonomy as trendIQ. */
export type TrendDirection = "up" | "down" | "flat";

/**
 * One era-baseline doc represents forward-looking pricing summary for
 * (productKey, year, cardClass). Refreshed daily.
 *
 * The compute pipeline (PR 4):
 *   1. Query CH for all comps in the bucket over the last 90 days.
 *   2. currentValue = recency-weighted average of the last 30 days
 *      (heavier weight for last-7-day sales).
 *   3. Fit a linear trend on the last 60 days → project 7 days forward
 *      → predictedValue.
 *   4. trendPct = (predictedValue - currentValue) / currentValue.
 *   5. trendDirection from trendPct with a ±3% dead-band.
 */
export interface EraBaselineDoc {
  /** sha1 of `${productKey}|${year}|${cardClass}`. */
  id: string;
  /** Cosmos partition key. */
  productKey: string;
  year: number;
  cardClass: CardClass;
  /**
   * Recency-weighted current value — "what does an average card in
   * this era bucket sell for right now?". Used by Tier 6 as the era
   * baseline for the floor calc.
   */
  currentValue: number;
  /**
   * 7-day forward projection. Same forward-looking shape as
   * `predictedPrice` on the top-level estimate response.
   */
  predictedValue: number;
  /**
   * Signed pct change from currentValue → predictedValue. Positive =
   * up trend, negative = down. Range typically [-0.30, 0.30] for era
   * buckets (aggregated data trends slowly).
   */
  trendPct: number;
  /** "up" / "down" / "flat" — trendPct bucketed with ±3% dead-band. */
  trendDirection: TrendDirection;
  /** How many comps fed the aggregation. */
  sampleSize: number;
  /**
   * Wide range around currentValue for display fallback. Not the
   * confidence interval — just [currentValue × 0.5, currentValue × 2.0]
   * so the Tier 6 caller has a range without re-computing.
   */
  currentRange: { low: number; high: number };
  /** ISO timestamp of the last refresh. */
  computedAt: string;
  schemaVersion: typeof ERA_BASELINE_SCHEMA_VERSION;
}
