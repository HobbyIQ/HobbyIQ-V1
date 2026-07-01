/**
 * CF-PLAYER-MOMENTUM-THIN-COMP-PROJECTION (2026-07-01):
 * Project a current price for thin-comp cards using player-level
 * momentum from the vendor-neutral player-trend layer.
 *
 * Intended trigger: card has 1-2 real comps in the trust window, so
 * the AI matcher and trust guard PASS, but the resulting FMV is based
 * on stale data. Applying the player's momentum ratio bumps the last
 * known sale to a current-market estimate.
 *
 * Purely a decision function. Fetching happens elsewhere; this file
 * evaluates trigger conditions and computes the projected price with
 * an explicit confidence downgrade so downstream can render the
 * appropriate "estimated / low confidence" UI treatment.
 *
 * Env-gated for rollback: PLAYER_MOMENTUM_PROJECTION_ENABLED must be
 * literal "true" (case-insensitive) — matches the MULTIPLIER_BASE_TABLE
 * flag semantics for consistency.
 */

import type {
  PlayerTrendSnapshot,
  SupplyTrendClassification,
} from "../playerTrend/playerTrend.types.js";
import { supplyTrendProjectionAdjuster } from "../playerTrend/supplyTrend.classify.js";

// ── Constants (empirically-derived guardrails) ─────────────────────────────
/** Cap upward projection. Even if player momentum spikes 5×, we clamp. */
const MAX_UPSIDE_MULTIPLIER = 2.0;
/** Cap downward projection symmetrically. */
const MIN_DOWNSIDE_MULTIPLIER = 0.5;
/** Player-week must have this many sales to trust the momentum ratio. */
const MIN_LATEST_WEEK_COUNT = 50;
/** Minimum |ratio - 1| to bother projecting (below this, no meaningful trend). */
const MIN_TREND_DELTA = 0.05;
/** Confidence ceiling for momentum-projected prices (they're derived, not observed). */
const CONFIDENCE_CEILING = 0.5;

// ── Types ───────────────────────────────────────────────────────────────────

export interface MomentumProjectionInput {
  /** Player name — used only for telemetry / attribution. */
  playerName: string;
  /** Snapshot from the player-trend layer. May be null (no signal). */
  trendSnapshot: PlayerTrendSnapshot | null;
  /** Most recent comp price for the specific card (any grade). Null when unknown. */
  lastCardSalePrice: number | null;
  /** ISO date of the last comp sale, or null. */
  lastCardSaleDate: string | null;
  /** Number of direct comps present for this card_id (post-trust-guard). */
  directCompCount: number;
  /** Days since the most recent direct comp (null when no comp). */
  daysSinceNewestComp: number | null;
}

export interface MomentumProjection {
  /** The projected current price. */
  projectedPrice: number;
  /** Downgraded confidence (max CONFIDENCE_CEILING). */
  confidence: number;
  /** For UI attribution: what fed the projection. */
  attribution: {
    lastCardSalePrice: number;
    lastCardSaleDate: string | null;
    lastCardSaleDaysOld: number | null;
    /** Raw sales-stats-by-player momentum ratio. Null when unavailable. */
    playerMomentumRatio: number | null;
    playerVolumeRatio: number | null;
    playerLatestWeekCount: number;
    /**
     * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01): which signal actually
     * drove the projection. `matched_cohort` = mix-bias-free ratio from the
     * background-cached matched-cohort compute (SUPERIOR). `raw_weekly_avg`
     * = fallback to raw sales-stats-by-player when the cohort cache misses.
     */
    activeRatioSource: "matched_cohort" | "raw_weekly_avg";
    /** The unclamped ratio used, whichever source was active. */
    activeRatio: number;
    /** Active ratio after upside/downside cap. */
    cappedRatio: number;
    /** Supply-trend leading-indicator classification. */
    supplyTrend: SupplyTrendClassification;
    /** Multiplier applied on top of cappedRatio to reflect supply-trend
     *  leading-indicator quadrants (`supply_dry` boosts, `supply_flood`
     *  discounts, others = 1.0). */
    supplyTrendAdjuster: number;
    providerName: string;
  };
}

export interface MomentumProjectionSkip {
  applied: false;
  reason:
    | "flag_disabled"
    | "no_trend_snapshot"
    | "no_last_card_sale"
    | "player_week_too_thin"
    | "no_momentum_ratio"
    | "trend_below_threshold"
    | "not_thin_comp";
}

export type MomentumProjectionResult =
  | ({ applied: true } & MomentumProjection)
  | MomentumProjectionSkip;

// ── Env gate ───────────────────────────────────────────────────────────────

/**
 * Read each call so test-time env stubs flip immediately.
 * Matches MULTIPLIER_BASE_TABLE_ENABLED semantics: only literal "true"
 * (case-insensitive) enables. "1", "yes", empty, unset all disable.
 */
export function isMomentumProjectionEnabled(): boolean {
  return (
    String(process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED ?? "")
      .toLowerCase() === "true"
  );
}

// ── Trigger evaluation ─────────────────────────────────────────────────────

/**
 * Is this card thin-comp enough to warrant projection?
 * Trigger: <= 2 direct comps, OR newest comp older than 60 days.
 */
export function isThinCompCard(
  directCompCount: number,
  daysSinceNewestComp: number | null,
): boolean {
  if (directCompCount <= 2) return true;
  if (daysSinceNewestComp !== null && daysSinceNewestComp > 60) return true;
  return false;
}

// ── Main projection function ───────────────────────────────────────────────

/**
 * Evaluate all triggers and, if they pass, compute the projected price.
 * Always returns a shape — never throws. Callers inspect `.applied` to
 * distinguish projection-fired from projection-skipped.
 */
export function evaluateMomentumProjection(
  input: MomentumProjectionInput,
): MomentumProjectionResult {
  if (!isMomentumProjectionEnabled()) {
    return { applied: false, reason: "flag_disabled" };
  }

  if (!isThinCompCard(input.directCompCount, input.daysSinceNewestComp)) {
    return { applied: false, reason: "not_thin_comp" };
  }

  if (!input.trendSnapshot) {
    return { applied: false, reason: "no_trend_snapshot" };
  }

  const { momentum, supplyTrend, providerName } = input.trendSnapshot;
  // Coerce undefined → null so downstream `!== null` checks work whether
  // the snapshot was built with the new-shape (explicit null) or with
  // an older factory that omitted the field entirely.
  const matchedCohort = input.trendSnapshot.matchedCohort ?? null;
  const latestWeek = momentum.latestCompleteWeek;
  if (!latestWeek || latestWeek.count < MIN_LATEST_WEEK_COUNT) {
    return { applied: false, reason: "player_week_too_thin" };
  }

  // CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01): prefer the mix-bias-free
  // matched-cohort medianRatio when the background job has populated the
  // cache. This is materially better than the raw sales-stats-by-player
  // weekly average — real prod validation on Eric Hartman (2026-07-01)
  // showed raw signal misleading by 44 points (raw=-8%, matched=+36%).
  // Fall back to raw momentumRatio when the cohort is unavailable
  // (cache miss, new player, or background job hasn't caught up).
  const activeRatio: number | null =
    matchedCohort !== null ? matchedCohort.medianRatio : momentum.momentumRatio;
  const activeRatioSource: "matched_cohort" | "raw_weekly_avg" =
    matchedCohort !== null ? "matched_cohort" : "raw_weekly_avg";

  if (activeRatio === null) {
    return { applied: false, reason: "no_momentum_ratio" };
  }
  // Explicit narrow — TS loses the null-check on the const later otherwise.
  const activeRatioNarrowed: number = activeRatio;

  if (Math.abs(activeRatioNarrowed - 1) < MIN_TREND_DELTA) {
    return { applied: false, reason: "trend_below_threshold" };
  }

  if (input.lastCardSalePrice === null || input.lastCardSalePrice <= 0) {
    return { applied: false, reason: "no_last_card_sale" };
  }

  // Cap the ratio symmetrically so a runaway signal doesn't inflate
  // a specific card's price beyond reason.
  const cappedRatio = clamp(activeRatioNarrowed, MIN_DOWNSIDE_MULTIPLIER, MAX_UPSIDE_MULTIPLIER);

  // Supply-trend leading-indicator kicker (see supplyTrend.classify.ts):
  // supply_dry (vol↓, price↑) boosts +5%; supply_flood (vol↑, price↓)
  // discounts -5%. Other quadrants get 1.0 (already reflected in
  // cappedRatio). Adjuster is small enough that a misclassification
  // isn't catastrophic; the momentum ratio dominates the projection.
  const supplyAdjuster = supplyTrendProjectionAdjuster(supplyTrend);
  const effectiveRatio = cappedRatio * supplyAdjuster;

  const projectedPrice = roundCents(input.lastCardSalePrice * effectiveRatio);

  // Confidence scales inversely with how far we had to project.
  // 5% delta → confidence 0.5 (ceiling). 50% delta → confidence ~0.3.
  // Uses the momentum-only delta (not adjuster-inclusive) so the supply
  // kicker doesn't inflate the confidence penalty on top of already
  // legitimate momentum.
  const delta = Math.abs(cappedRatio - 1);
  const confidence = Math.min(
    CONFIDENCE_CEILING,
    Math.max(0.15, CONFIDENCE_CEILING - delta * 0.4),
  );

  return {
    applied: true,
    projectedPrice,
    confidence: round3(confidence),
    attribution: {
      lastCardSalePrice: input.lastCardSalePrice,
      lastCardSaleDate: input.lastCardSaleDate,
      lastCardSaleDaysOld: input.daysSinceNewestComp,
      playerMomentumRatio: momentum.momentumRatio,
      playerVolumeRatio: momentum.volumeRatio,
      playerLatestWeekCount: latestWeek.count,
      activeRatio: activeRatioNarrowed,
      activeRatioSource,
      cappedRatio,
      supplyTrend,
      supplyTrendAdjuster: supplyAdjuster,
      providerName,
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
