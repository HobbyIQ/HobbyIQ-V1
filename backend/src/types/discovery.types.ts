// CF-DISCOVERY-SURFACES (Drew, 2026-07-17). Types for two discovery
// surfaces on top of the corpus:
//   - Missing Parallels: for each (player, year, cardSet) the user
//     owns, list parallels they DON'T own (upsell + set-completion UX)
//   - Sub-Raw Discovery: raw cards trading well below expected PSA 10
//     value, filtered by family multiplier confidence (value-hunter UX)

/** Missing parallels result. One entry per (player, year, set)
 *  spanning the user's holdings; each entry lists parallels the user
 *  doesn't have but exist in the corpus. */
export interface MissingParallelsInput {
  ownedCardIds: Set<string>;
  ownedByPlayerYearSet: Map<string, Set<string>>;
}

export interface MissingParallelsBundle {
  player: string;
  year: number;
  cardSet: string;
  ownedVariants: string[];
  missingParallels: MissingParallelEntry[];
}

export interface MissingParallelEntry {
  cardId: string;
  variant: string;
  number: string;
  recentSales: number;
  medianPrice: number;
  imageUrl: string | null;
}

/** Sub-raw discovery. Raw cards where raw price << expected PSA 10 value. */
export interface SubRawCandidate {
  cardId: string;
  player: string;
  year: number;
  cardSet: string;
  variant: string;
  number: string;
  medianRawPrice: number;
  familyKey: string;
  familyPsa10Multiplier: number;
  familyPsa10Confidence: "high" | "medium" | "low";
  expectedPsa10Price: number;
  gradingCostAssumed: number;
  expectedGain: number;
  expectedGainMultiple: number;   // (expectedPsa10Price - rawPrice - gradingCost) / rawPrice
  rawComps: number;
  imageUrl: string | null;
}

/** Options for sub-raw discovery. */
export interface SubRawDiscoveryOptions {
  /** Maximum raw price per card to be considered (default $30 for value-hunter mode). */
  maxRawPrice?: number;
  /** Minimum expected gain ($) to surface. Default $200. */
  minExpectedGain?: number;
  /** Minimum expected gain multiple (expectedGain / rawPrice). Default 5.0. */
  minExpectedGainMultiple?: number;
  /** Grading cost assumed for PSA (default $80 — Regular tier from grading catalog). */
  gradingCostAssumed?: number;
  /** Family multiplier confidence filter — "high" | "medium" | "any". Default "medium". */
  minFamilyConfidence?: "high" | "medium" | "any";
  /** Top-N candidates to return, sorted by expectedGain DESC. Default 25. */
  topN?: number;
}
