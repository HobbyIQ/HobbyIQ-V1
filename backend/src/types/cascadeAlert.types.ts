// CF-CASCADE-ALERTS (Drew, 2026-07-17). Detection of "insider
// cascade" signals — moments when a player's GRADED market is
// moving significantly faster than their RAW market, before the
// wider raw market catches on. Directly serves the [[product-
// actionable-seller-intelligence]] head-start-window thesis.
//
// Cross-sectional detection (no day-over-day comparison needed):
// works from a single nightly's stratified player_trends result.

/** Shape of the trend snapshot we detect against — the subset of
 *  StratifiedPlayerTrendResult the detector needs. Kept minimal so
 *  this type doesn't drag the whole player-trend surface into scope. */
export interface CascadeDetectionInput {
  player: string;
  raw: {
    momentum: number;
    direction: "up" | "flat" | "down";
    qualifyingCards: number;
    velocityPerWeek: number;
  } | null;
  graded: {
    momentum: number;
    direction: "up" | "flat" | "down";
    qualifyingCards: number;
    velocityPerWeek: number;
  } | null;
  computedAt: string;
}

/** Options for the detector. */
export interface CascadeDetectionOptions {
  /** Min ratio of graded.momentum to raw.momentum. Default 1.15 (15%). */
  minMomentumRatio?: number;
  /** Min graded.momentum in absolute terms. Default 1.10 (10%). */
  minGradedMomentum?: number;
  /** Min qualifyingCards in each variant. Default 3. */
  minQualifyingCardsPerVariant?: number;
}

/** One cascade event = one player, one detection. */
export interface CascadeEvent {
  player: string;
  playerSlug: string;
  detectedAt: string;
  detectionInput: {
    rawMomentum: number;
    gradedMomentum: number;
    momentumRatio: number;
    gradedDirection: "up" | "flat" | "down";
    rawQualifyingCards: number;
    gradedQualifyingCards: number;
    playerTrendComputedAt: string;
  };
  severity: "insider" | "emerging" | "confirmed";
  reason: string;
}

/** Batch result. */
export interface CascadeDetectionResult {
  computedAt: string;
  scanned: number;
  detected: number;
  events: CascadeEvent[];
}
