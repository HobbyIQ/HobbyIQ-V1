// TrendIQ V1 — forward-looking composite score per card.
//
// Three-layer composite (player momentum + card-level trajectory +
// segment trajectory anchored to last sale date) reduced to a single
// multiplier centered on 1.0. Surfaced as the canonical product
// signal on /api/compiq/price and downstream endpoints.
//
// Spec + locked methodology: docs/phase0/trendiq_design.md
// Phase 1 methodology locked 2026-05-25.

export type TrendIQDirection = "up" | "flat" | "down";

export type TrendIQCoverage =
  | "full"          // all three layers populated
  | "no_segment"    // L1 + L2 only
  | "no_card"       // L1 + L3 only
  | "segment_only"  // L3 only (and L1 if available)
  | "card_only"     // L2 only (and L1 if available)
  | "player_only"   // L1 only — low-confidence directional
  | "insufficient"; // nothing → composite 1.0, flat

export interface PlayerMomentumComponent {
  /** Aggregator's final_multiplier, clamped 0.70..1.50. */
  multiplier: number;
  /** Signal flags that fired (e.g. "trends_spike"). */
  flags: string[];
  /** Per-signal contribution map from aggregator. Scalar by default;
   *  CF-PLAYER-IN-SET-PER-CARD-DIRECTION (2026-06-10) added
   *  `per_card_ratios` as an array breakdown so iOS / advisor can show
   *  "3 of 5 cards down" instead of one pooled number. */
  componentSignals: Record<string, number | readonly unknown[]>;
  /** ISO timestamp from the aggregator's last write. */
  lastUpdated: string | null;
  /** URL the signal fetch hit (null if env unconfigured). */
  sourceUrl: string | null;
}

export interface CardTrajectoryComponent {
  /** Equivalent multiplier: clamp(0.70, 1.50, 1 + pctChange/100). */
  multiplier: number;
  /** Raw % change recent vs older, clamped ±50. */
  pctChange: number;
  recentMedian: number;
  olderMedian: number;
  recentCount: number;
  olderCount: number;
  /** Fixed at 14 in V1 (0..14d). */
  windowRecentDays: number;
  /** Span of older window in days (15..45 = 30d span). */
  windowOlderDays: number;
}

export interface SegmentTrajectoryComponent {
  /** clamp(0.70, 1.50, 1 + pctChange/100). */
  multiplier: number;
  /** Raw % change post-anchor vs pre-anchor, clamped ±50. */
  pctChange: number;
  /**
   * ISO date actually used as window pivot. Equals originalAnchorDate
   * when the true last sale is recent enough (<=180d); equals
   * (now - 90d) when re-anchoring fires for stale-last-sale cards.
   */
  effectiveAnchorDate: string;
  /**
   * This card's true last-sale ISO date, or null if never sold.
   * When effectiveAnchorDate !== originalAnchorDate, re-anchoring
   * was applied — UI can communicate transparently:
   * "Last sale: 250 days ago — segment trajectory uses 90-day window".
   */
  originalAnchorDate: string | null;
  /** Total span considered (default 60, capped at 90 when re-anchoring). */
  windowDays: number;
  preAnchorMedian: number;
  postAnchorMedian: number;
  preAnchorCount: number;
  postAnchorCount: number;
  /** Sibling cards in pool (same player+year+set, exact card_id excluded). */
  siblingsScanned: number;
  /** Total sales pooled (siblings, pre + post anchor). */
  totalSamples: number;
}

export interface TrendIQComponents {
  playerMomentum: PlayerMomentumComponent | null;
  cardTrajectory: CardTrajectoryComponent | null;
  segmentTrajectory: SegmentTrajectoryComponent | null;
}

/** Fractional weights per layer. Sums to 1.0 when any layer is present. */
export interface TrendIQWeights {
  playerMomentum: number;
  cardTrajectory: number;
  segmentTrajectory: number;
}

export interface TrendIQResult {
  /** Forward-looking composite multiplier, clamp(0.70, 1.50). */
  composite: number;
  /** ±3% deadband around 1.0 → "flat"; else "up" / "down". */
  direction: TrendIQDirection;
  /** round((composite - 1) * 100, 1). */
  impliedPct: number;
  /** Most recent of available component last_updated values. */
  lastUpdated: string | null;
  components: TrendIQComponents;
  weights: TrendIQWeights;
  coverage: TrendIQCoverage;
}

/**
 * CF-TRENDIQ-SURFACES (2026-06-03): Layer-3 raw-data extension surfaced by
 * /api/compiq/trendiq/full (pro_seller). Composite math + the
 * `SegmentTrajectoryComponent` returned in `TrendIQResult` are UNCHANGED;
 * this is a separate, additive object built from the same in-flight data.
 *
 * Cardsight TOS hedge — `preAnchorSales` / `postAnchorSales` are gated by
 * env `TRENDIQ_FULL_RAW_SALES_DISABLED` at the route layer (single
 * togglable block, not scattered guards). When stripped, the response
 * still carries siblingCardIds + counts + perWindow percentiles.
 */
export interface SegmentTrajectoryFull {
  siblingCardIds: ReadonlyArray<string>;
  reanchorApplied: boolean;
  effectiveAnchorDate: string;
  originalAnchorDate: string | null;
  preAnchorSales: ReadonlyArray<{ price: number; ts: number }>;
  postAnchorSales: ReadonlyArray<{ price: number; ts: number }>;
  perWindow: {
    pre: { mean: number; p25: number; p75: number };
    post: { mean: number; p25: number; p75: number };
  };
}

/** Neutral fallback used when computation cannot proceed at all. */
export const NEUTRAL_TRENDIQ: TrendIQResult = {
  composite: 1.0,
  direction: "flat",
  impliedPct: 0,
  lastUpdated: null,
  components: {
    playerMomentum: null,
    cardTrajectory: null,
    segmentTrajectory: null,
  },
  weights: {
    playerMomentum: 0,
    cardTrajectory: 0,
    segmentTrajectory: 0,
  },
  coverage: "insufficient",
};
