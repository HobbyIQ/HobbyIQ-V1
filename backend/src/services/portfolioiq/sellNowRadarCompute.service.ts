// CF-SELL-NOW-RADAR (Drew, 2026-07-17). Pure math for the timed-sell
// detector. Given a SKU-level velocity trend + a player-level momentum
// read, decide whether this is a "list it now" moment.
//
// Signal model (default gate):
//   - card velocityPerWeek >= 2x SKU baseline
//         (baseline = typical rolling weekly volume from a wider window)
//   - player momentum >= 1.10   (matched-cohort — 10%+ over prior window)
//   - player direction === "up"
//   - card direction in {"up","flat"}   — never sell into a downtrend
//
// Urgency score is a bounded [1.0 .. 10.0] read of
//   velocityMultiple x max(playerMomentum, 1.0)
// clamped so a single 12x velocity spike on a superstar can't dominate the
// list; sort is stable by (velocityMultiple x momentum) DESC on the same
// number that drives urgency, so downstream rendering just walks it.
//
// See [[matched-cohort-supersedes-raw]] — player momentum here comes from
// the matched-cohort pipeline (per-card ratio mean), not raw aggregate
// price average.

/** Card-level trend numbers consumed by the gate. */
export interface SellRadarCardTrend {
  /** Current weekly sale count on this SKU (from localCompTrend). */
  velocityPerWeek: number;
  /** Baseline weekly sale count on this SKU — typical volume when the
   *  card isn't heating up. Derived from a wider historical window
   *  than the "current" number. Use 0 to indicate "no baseline yet",
   *  which disqualifies the candidate (can't compute a multiple). */
  velocityBaseline: number;
  /** Categorical trend direction from localCompTrend. */
  direction: "up" | "flat" | "down";
  /** Optional — helps the reason string when present. */
  slopePerDay?: number;
}

/** Player-level trend numbers consumed by the gate. */
export interface SellRadarPlayerTrend {
  /** Matched-cohort momentum (mean of per-card recent/prior ratios). 1.0
   *  = flat, 1.10 = +10%, 0.85 = -15%. */
  momentum: number;
  /** Categorical direction from the same computation. */
  direction: "up" | "flat" | "down";
  /** Sanity flags — "sparse" disqualifies the candidate regardless of
   *  numeric direction, since the pool isn't trustworthy. */
  flags?: string[];
}

/** Tunable thresholds — surfaced so callers can override for regime
 *  experiments and tests can pin defaults. */
export interface SellRadarOptions {
  /** velocityPerWeek / velocityBaseline must clear this. Default 2.0. */
  minVelocityMultiple?: number;
  /** player momentum must clear this. Default 1.10. */
  minPlayerMomentum?: number;
  /** cap on urgency score. Default 10.0. */
  urgencyCap?: number;
}

const DEFAULT_MIN_VELOCITY_MULTIPLE = 2.0;
const DEFAULT_MIN_PLAYER_MOMENTUM = 1.10;
const DEFAULT_URGENCY_CAP = 10.0;
const URGENCY_FLOOR = 1.0;

/** Result surfaced for a single (card, player) pair. When
 *  `isCandidate === false` the `reason` field explains which gate
 *  clause fired — useful for diagnostics and the "why not?" case. */
export interface SellRadarComputeResult {
  isCandidate: boolean;
  velocityMultiple: number;
  urgencyScore: number;
  reason: string;
  /** Which gate rejected — null when isCandidate=true. */
  rejectedBy:
    | null
    | "missing_card_trend"
    | "missing_player_trend"
    | "no_baseline"
    | "velocity_below_gate"
    | "momentum_below_gate"
    | "player_direction_not_up"
    | "card_direction_down"
    | "player_pool_sparse";
}

/** Pure-math decision. Never throws. */
export function evaluateSellNowCandidate(
  cardTrend: SellRadarCardTrend | null,
  playerTrend: SellRadarPlayerTrend | null,
  opts: SellRadarOptions = {},
): SellRadarComputeResult {
  const minVelocityMultiple = opts.minVelocityMultiple ?? DEFAULT_MIN_VELOCITY_MULTIPLE;
  const minPlayerMomentum = opts.minPlayerMomentum ?? DEFAULT_MIN_PLAYER_MOMENTUM;
  const urgencyCap = opts.urgencyCap ?? DEFAULT_URGENCY_CAP;

  if (!cardTrend) {
    return {
      isCandidate: false,
      velocityMultiple: 0,
      urgencyScore: 0,
      reason: "No card-level comps in window",
      rejectedBy: "missing_card_trend",
    };
  }

  if (!playerTrend) {
    return {
      isCandidate: false,
      velocityMultiple: 0,
      urgencyScore: 0,
      reason: "No player-level trend available",
      rejectedBy: "missing_player_trend",
    };
  }

  // Sparse cohort — matched-cohort momentum with <3 qualifying cards
  // isn't a signal, it's noise.
  if (playerTrend.flags && playerTrend.flags.includes("sparse")) {
    return {
      isCandidate: false,
      velocityMultiple: 0,
      urgencyScore: 0,
      reason: "Player pool too sparse to trust momentum",
      rejectedBy: "player_pool_sparse",
    };
  }

  if (!(cardTrend.velocityBaseline > 0)) {
    return {
      isCandidate: false,
      velocityMultiple: 0,
      urgencyScore: 0,
      reason: "No SKU baseline velocity to compare against",
      rejectedBy: "no_baseline",
    };
  }

  const velocityMultiple = cardTrend.velocityPerWeek / cardTrend.velocityBaseline;

  if (velocityMultiple < minVelocityMultiple) {
    return {
      isCandidate: false,
      velocityMultiple,
      urgencyScore: 0,
      reason: `Velocity ${velocityMultiple.toFixed(2)}x baseline — below ${minVelocityMultiple.toFixed(2)}x gate`,
      rejectedBy: "velocity_below_gate",
    };
  }

  if (playerTrend.direction !== "up") {
    return {
      isCandidate: false,
      velocityMultiple,
      urgencyScore: 0,
      reason: `Player direction is ${playerTrend.direction}, not up`,
      rejectedBy: "player_direction_not_up",
    };
  }

  if (playerTrend.momentum < minPlayerMomentum) {
    const pctMove = (playerTrend.momentum - 1) * 100;
    return {
      isCandidate: false,
      velocityMultiple,
      urgencyScore: 0,
      reason: `Player momentum ${pctMove.toFixed(1)}% — below ${((minPlayerMomentum - 1) * 100).toFixed(1)}% gate`,
      rejectedBy: "momentum_below_gate",
    };
  }

  if (cardTrend.direction === "down") {
    return {
      isCandidate: false,
      velocityMultiple,
      urgencyScore: 0,
      reason: "Card direction is down — never sell into a falling market",
      rejectedBy: "card_direction_down",
    };
  }

  const raw = velocityMultiple * Math.max(playerTrend.momentum, 1);
  const urgencyScore = clamp(raw, URGENCY_FLOOR, urgencyCap);

  const playerPctMove = (playerTrend.momentum - 1) * 100;
  const reason = `Trading ${velocityMultiple.toFixed(1)}x baseline; player market up +${playerPctMove.toFixed(0)}%`;

  return {
    isCandidate: true,
    velocityMultiple,
    urgencyScore,
    reason,
    rejectedBy: null,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** Exposed for direct test coverage. */
export const _SELL_RADAR_DEFAULTS = {
  minVelocityMultiple: DEFAULT_MIN_VELOCITY_MULTIPLE,
  minPlayerMomentum: DEFAULT_MIN_PLAYER_MOMENTUM,
  urgencyCap: DEFAULT_URGENCY_CAP,
  urgencyFloor: URGENCY_FLOOR,
} as const;
