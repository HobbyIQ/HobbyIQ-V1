// CF-PORTFOLIO-MOMENTUM (Drew, 2026-07-17). One-tap "how is YOUR
// portfolio moving?" — aggregate every holding's matched-cohort
// player ratio into a single portfolio-level momentum number.
//
// Composition: value-weighted mean of per-holding player momentum
// (fetched from player_trends). Falls through gracefully when a
// player has no trend row yet — that holding contributes to counts
// but not the aggregate.

export interface PortfolioMomentumHoldingInput {
  holdingId: string;
  playerName: string | null;
  currentValue: number | null;   // per-unit fairMarketValueLive × quantity, when known
  quantity: number;              // default 1
}

export interface PortfolioMomentumPlayerTrend {
  playerName: string;
  momentum: number;              // matched-cohort ratio; 1 = flat
  direction: "up" | "flat" | "down";
  velocityPerWeek: number;
}

export interface PortfolioMomentumOptions {
  /** Threshold above which a holding counts as "up" (default 1.05, matches
   *  playerTrendCompute's up-threshold). */
  upThreshold?: number;
  /** Threshold below which a holding counts as "down" (default 0.95). */
  downThreshold?: number;
  /** Top-N movers emitted in each direction (default 3). */
  topMoversCount?: number;
}

export interface PortfolioMomentumMoverEntry {
  holdingId: string;
  playerName: string;
  momentum: number;
  direction: "up" | "flat" | "down";
  contributionUsd: number | null;   // holding value * (momentum - 1); null when currentValue missing
}

export interface PortfolioMomentumResult {
  computedAt: string;
  scannedHoldings: number;
  holdingsWithTrend: number;
  /** Value-weighted mean of per-holding momentum. 1.0 = flat portfolio.
   *  Falls back to unweighted mean when NO holdings have currentValue. */
  portfolioMomentum: number;
  /** Categorical direction of `portfolioMomentum`, gated by up/down thresholds. */
  direction: "up" | "flat" | "down";
  cardsUp: number;
  cardsFlat: number;
  cardsDown: number;
  cardsUntracked: number;
  topMovers: PortfolioMomentumMoverEntry[];
  worstMovers: PortfolioMomentumMoverEntry[];
  /** Total dollar delta implied by the momentum × currentValue. Descriptive
   *  only — not a forecast; explicitly labelled "implied" for iOS copy. */
  impliedPortfolioDelta: number | null;
}
