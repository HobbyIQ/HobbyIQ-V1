// CF-GRADE-WORTHY (Drew, 2026-07-17). Types for the grade-worthy
// analysis. Compares expected graded sale price against grading cost +
// current raw price to surface actionable "grade this now" alerts.

/** Input to the pure math. Everything the compute needs is here — no IO. */
export interface GradeWorthyInputs {
  /** Median or projected next-sale price for the raw version of this SKU. */
  rawPrice: number;
  /** Observed grader-premium curve from local comp store, e.g.
   *   { "PSA 10": { n: 40, meanPrice: 380, multiplierVsBaseline: 4.8 }, ... }
   *  Baseline (Raw) is included with multiplier 1.0. */
  graderPremiums: Record<string, GraderPremiumInput>;
  /** Grading tier cost catalog. Key = grade company + service level id;
   *  value = dollars. E.g. `psa-value` → 25, `psa-quick` → 75. */
  gradingCosts: Record<string, number>;
  /** Optional per-player context — if momentum is "down" we suppress
   *  low-margin recommendations (grading is a 60-90d commitment; a
   *  falling market can eat the margin during turnaround). Default: not
   *  used if omitted. */
  playerMomentumDirection?: "up" | "flat" | "down";
}

export interface GraderPremiumInput {
  n: number;
  meanPrice: number;
  multiplierVsBaseline: number;
}

/** Per-tier analysis row. */
export interface GradeWorthyTier {
  graderTier: string;                    // e.g. "PSA 10"
  gradedMedianPrice: number;             // observed graded price
  gradedSampleSize: number;              // n comps at this tier
  gradingCostAssumed: number;            // cheapest applicable cost from catalog
  expectedGain: number;                  // gradedMedianPrice - rawPrice - gradingCost
  expectedRoi: number;                   // expectedGain / (rawPrice + gradingCost)
  recommendation: "grade_now" | "grade_worthy_but_wait" | "not_worth" | "insufficient_data";
  reason: string;                        // one-line human-readable
}

/** Result of a single-holding analysis. */
export interface GradeWorthyAnalysis {
  rawPrice: number;
  bestTier: GradeWorthyTier | null;      // highest expectedGain across analyzed tiers
  allTiers: GradeWorthyTier[];           // per-tier breakdown (sorted by expectedGain DESC)
  overallRecommendation: "grade_now" | "grade_worthy_but_wait" | "not_worth" | "insufficient_data";
  reason: string;
}

/** Portfolio-scan result — one entry per holding, sorted by best-tier
 *  expectedGain DESC. Empty when no holdings are grade-worthy. */
export interface GradeWorthyPortfolioScanResult {
  scannedHoldings: number;
  gradeWorthyCount: number;
  candidates: Array<{
    holdingId: string;
    cardTitle: string;
    player: string;
    year: number | null;
    set: string;
    variant: string;
    number: string;
    analysis: GradeWorthyAnalysis;
  }>;
}
