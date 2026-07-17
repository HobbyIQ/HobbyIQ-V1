// CF-OBSERVED-MULTIPLIERS (Drew, 2026-07-17). Per-family observed
// grader multipliers computed from ch_daily_sales. Replaces the
// hand-written multipliers for cases where the corpus has enough
// evidence, and provides a blended-average fallback when a specific
// SKU's own graded-tier comps are sparse.
//
// Family key = normalized card_set_type (e.g. "Bowman Chrome Baseball" →
// "bowman_chrome_baseball"). Same family shares parallel structure and
// buyer archetype — a good bucketing for grader-premium averages.

/** Individual sale as consumed by the compute. */
export interface FamilySale {
  cardSetType: string;
  price: number;
  grader: string;     // "Raw", "PSA", "BGS", ...
  grade: string;      // "10", "9.5", "PSA 10", ... (grader-prefixed form varies)
  saleDate: string;
}

/** Options for the compute. */
export interface ObservedMultipliersOptions {
  /** Only include sales from within this window. Default 90 days. */
  windowDays?: number;
  /** Minimum raw n per family to publish any multiplier. Default 20. */
  minRawSamples?: number;
  /** Minimum graded n per (family, tier) to publish. Default 5. */
  minGradedSamples?: number;
  /** Which grader tiers to compute. Default: PSA 9/9.5/10, BGS 9/9.5/10,
   *  SGC 9/9.5/10, CGC 9/9.5/10. */
  targetTiers?: string[];
}

/** One observed multiplier row. */
export interface FamilyMultiplierRow {
  familyKey: string;         // "bowman_chrome_baseball"
  familyLabel: string;       // "Bowman Chrome Baseball"
  graderTier: string;        // "PSA 10"
  /** median(graded price) / median(raw price) */
  multiplier: number;
  nGraded: number;
  nRaw: number;
  medianGradedPrice: number;
  medianRawPrice: number;
  /** confidence bucket:
   *   "high":   nGraded ≥ 30 AND nRaw ≥ 100
   *   "medium": nGraded ≥ 10 AND nRaw ≥ 50
   *   "low":    at least minGradedSamples + minRawSamples, else omitted
   */
  confidence: "high" | "medium" | "low";
  computedAt: string;
}

/** Result of the compute. */
export interface ObservedMultipliersResult {
  computedAt: string;
  windowDays: number;
  familiesConsidered: number;
  familiesPublished: number;
  rows: FamilyMultiplierRow[];
}
