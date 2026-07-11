// CF-NO-NULL-PRICING (2026-07-11, Drew — PR 2 types).
//
// Cosmos container `era-baselines` stores median-sale summaries per
// (productKey, year, cardClass). Refreshed by a daily background job
// (PR 4 in the arc) that aggregates CH sales across every card in
// each product-year, regardless of player or parallel.
//
// Consumed by Tier 6 (referenceCatalogBaseline) as the PRIMARY source
// when the container is populated; falls back to the hand-curated
// static table when the container is empty or the specific tuple is
// missing.

export const ERA_BASELINE_SCHEMA_VERSION = 1;

/** Autograph vs raw base — same discriminator the ladder uses. */
export type CardClass = "auto" | "base";

/**
 * One era-baseline doc represents the summary stats for
 * (productKey, year, cardClass). Refreshed daily.
 */
export interface EraBaselineDoc {
  /** sha1 of `${productKey}|${year}|${cardClass}`. */
  id: string;
  /** Cosmos partition key. */
  productKey: string;
  year: number;
  cardClass: CardClass;
  /** Median sale across all comps in the bucket. */
  medianSale: number;
  /** 25th percentile — lower bound for range display. */
  p25Sale: number;
  /** 75th percentile — upper bound for range display. */
  p75Sale: number;
  /** How many comps fed the aggregation. */
  sampleSize: number;
  /** ISO timestamp of the last refresh. */
  computedAt: string;
  schemaVersion: typeof ERA_BASELINE_SCHEMA_VERSION;
}
