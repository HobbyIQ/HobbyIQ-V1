// CF-GRADER-OUTCOMES (Drew, 2026-07-17). Types for the observed
// grader-outcome distributions. Grouped by (family, grader), the
// tierShares record shows what fraction of GRADED SALES fall at each
// tier — informative for probability-weighted grade-worthy expected
// value.
//
// IMPORTANT interpretation caveat (called out in the endpoint response
// and the iOS prompt): this is the distribution of OUTCOMES visible
// on the sales market, not "P(getting tier X | you submit)". Sales
// data is post-grading and biased by:
//   - survival: high grades sell more often (crack-and-resub bias)
//   - low-grade suppression: PSA 1-4 rarely surface in raw-heavy markets
// Still useful as a directional proxy — a family where PSA 10 is 30%
// of graded sales tells a very different EV story than 3%.

/** Input to the pure math. Same shape as observedMultipliers's FamilySale. */
export interface OutcomeSale {
  cardSetType: string;
  price: number;
  grader: string;   // "Raw", "PSA", "BGS", "SGC", "CGC"
  grade: string;    // "PSA 10", "BGS 9.5", "Raw" — grader-prefixed form
  saleDate: string;
}

/** Options for the compute. */
export interface GraderOutcomeOptions {
  windowDays?: number;         // default 90
  minGradedSamples?: number;   // default 20 per (family, grader)
}

/** One row per (family, grader). */
export interface GraderOutcomeRow {
  familyKey: string;
  familyLabel: string;
  grader: string;              // "PSA", "BGS", ...
  /** { "PSA 10": 0.28, "PSA 9": 0.42, ...} — SHARES sum to 1.0.
   *  Only tiers with observed sales appear as keys. */
  tierShares: Record<string, number>;
  /** { "PSA 10": 47, ... } counts backing the shares. */
  tierCounts: Record<string, number>;
  totalGradedSamples: number;
  /** high: ≥ 100 graded samples for the (family, grader)
   *  medium: ≥ 30
   *  low: meets minGradedSamples (default 20) */
  confidence: "high" | "medium" | "low";
  computedAt: string;
}

/** Result of the compute — one row per (family, grader). */
export interface GraderOutcomeResult {
  computedAt: string;
  windowDays: number;
  rows: GraderOutcomeRow[];
}
