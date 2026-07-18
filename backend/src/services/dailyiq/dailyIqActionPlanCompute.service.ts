// CF-DAILYIQ-ACTION-PLAN (Drew, 2026-07-17). Pure verdict-and-urgency
// math for the master DailyIQ Action Plan surface. Given all the
// per-holding signals we've built over the past week (matched-cohort
// momentum, sell-now radar, grade-worthy analysis, cascade alerts,
// predicted price, guestimate), emit ONE verdict per holding with a
// bounded urgency score and a human-readable reason.
//
// The verdict lattice (priority order — first-match wins):
//   SELL_NOW      — velocity + momentum aligned, cascade fresh, no downtrend
//   LIST_HIGHER   — predicted-price meaningfully above current asking
//   GRADE_UP      — grade-worthy expected uplift crosses threshold
//   WAIT_TO_LIST  — momentum up but velocity thin — rising, not urgent
//   HOLD          — no strong signal
//
// Urgency is bounded [0,100] so downstream (iOS + push) can sort a
// mixed feed by one number regardless of verdict. Each verdict has
// its own base range so a HOLD urgency of 20 can't outrank a
// SELL_NOW urgency of 70 — the base ranges don't overlap.
//
// This service is PURE — no I/O, no async. Fed by
// dailyIqActionPlanAnalyze which orchestrates the per-holding signal
// fetches. Testable in isolation via tests/dailyIqActionPlanCompute.test.ts.

export type ActionVerdict =
  | "SELL_NOW"
  | "LIST_HIGHER"
  | "GRADE_UP"
  | "WAIT_TO_LIST"
  | "HOLD";

export interface ActionPlanInputs {
  /** Current market value (matched-cohort-backed after PR #543). */
  marketValue: number | null;
  /** 7d predicted price from the same signal chain. */
  predictedPrice: number | null;
  /** User's current asking price if the card is currently listed. Null
   *  when unlisted. Falls back to marketValue for LIST_HIGHER gap math. */
  currentAskingPrice?: number | null;

  /** Sell-now-radar signal (PR #539). */
  sellRadar?: {
    velocityMultiple: number;   // 2.0+ triggers gate
    playerMomentum: number;     // 1.10+ triggers gate
    playerDirection: "up" | "flat" | "down";
    cardDirection: "up" | "flat" | "down";
  } | null;

  /** Cascade alert on this player-family (PR #531). Null when none. */
  cascade?: {
    firedAt: string;           // ISO timestamp
    daysSinceFire: number;
    audienceTier: "insider" | "beat_writer" | "engaged_fan" | "buyer";
  } | null;

  /** Grade-worthy analysis output (PR #530). Populated only when the
   *  holding is a Raw candidate with a viable graded tier. */
  gradeWorthy?: {
    bestTier: string;                // "PSA 10" etc
    expectedNetUplift: number;       // $ after grading cost
    expectedUpliftPct: number;       // uplift / rawPrice
    confidence: "high" | "medium" | "low";
  } | null;

  /** Matched-cohort weekly rate (PR #543 wired). */
  matchedCohortWeeklyRate?: number | null;

  /** True when marketValue came from a guestimate compound rather than
   *  real comps (PR #545). Used to soften urgency — we don't shout
   *  SELL_NOW on a guestimated number. */
  isGuestimate?: boolean;
}

export interface ActionPlanResult {
  verdict: ActionVerdict;
  urgency: number;              // [0, 100]
  reason: string;               // one-line seller-facing rationale
  priceTarget: number | null;   // recommended listing / sell price
  windowClosesIn: string | null; // "in 5 days" | null for indefinite
}

const URGENCY_RANGES: Record<ActionVerdict, [number, number]> = {
  SELL_NOW:     [70, 100],
  GRADE_UP:     [40,  69],
  LIST_HIGHER:  [25,  60],   // overlaps into GRADE_UP intentionally
  WAIT_TO_LIST: [10,  30],
  HOLD:         [ 0,   9],
};

const SELL_NOW_VELOCITY_MIN = 2.0;
const SELL_NOW_MOMENTUM_MIN = 1.10;
const CASCADE_FRESH_DAYS = 14;    // cascade counts as "fresh" within 2 weeks
const LIST_HIGHER_GAP_PCT = 0.15;  // predicted must be >=15% above asking
const GRADE_UP_MIN_UPLIFT_PCT = 0.30; // net expected uplift >=30%

export function computeActionPlan(inp: ActionPlanInputs): ActionPlanResult {
  const marketValue = typeof inp.marketValue === "number" && inp.marketValue > 0
    ? inp.marketValue : null;
  const predictedPrice = typeof inp.predictedPrice === "number" && inp.predictedPrice > 0
    ? inp.predictedPrice : null;

  // ── SELL_NOW gate ───────────────────────────────────────────────────
  // Velocity + momentum aligned, cascade fresh, no downtrend, real comps
  const sellNowFires =
    !inp.isGuestimate
    && inp.sellRadar !== null && inp.sellRadar !== undefined
    && inp.sellRadar.velocityMultiple >= SELL_NOW_VELOCITY_MIN
    && inp.sellRadar.playerMomentum >= SELL_NOW_MOMENTUM_MIN
    && inp.sellRadar.playerDirection === "up"
    && inp.sellRadar.cardDirection !== "down";

  if (sellNowFires) {
    const cascadeBoost =
      inp.cascade !== null && inp.cascade !== undefined
      && inp.cascade.daysSinceFire <= CASCADE_FRESH_DAYS ? 15 : 0;
    // velocityMultiple × playerMomentum: baseline 2×1.1=2.2 → 3+ = strong
    const strength = (inp.sellRadar!.velocityMultiple ?? 2)
                   * (inp.sellRadar!.playerMomentum ?? 1);
    const rawUrgency = 60 + Math.min(30, (strength - 2) * 8) + cascadeBoost;
    const urgency = clamp(rawUrgency, URGENCY_RANGES.SELL_NOW[0], URGENCY_RANGES.SELL_NOW[1]);
    const priceTarget =
      predictedPrice !== null ? Math.round(predictedPrice * 100) / 100 :
      marketValue !== null ? Math.round(marketValue * 100) / 100 :
      null;
    const cascadeSuffix = inp.cascade
      ? ` · cascade fired ${inp.cascade.daysSinceFire}d ago`
      : "";
    const reason =
      `Velocity ${inp.sellRadar!.velocityMultiple.toFixed(1)}× baseline`
      + ` · player ${((inp.sellRadar!.playerMomentum - 1) * 100).toFixed(0)}%/wk`
      + cascadeSuffix;
    return {
      verdict: "SELL_NOW",
      urgency,
      reason,
      priceTarget,
      windowClosesIn: inp.cascade
        ? `in ~${Math.max(1, 21 - inp.cascade.daysSinceFire)} days`
        : null,
    };
  }

  // ── GRADE_UP gate ────────────────────────────────────────────────────
  // Real graded uplift crosses threshold and confidence is not "low"
  const gradeUpFires =
    !inp.isGuestimate
    && inp.gradeWorthy !== null && inp.gradeWorthy !== undefined
    && inp.gradeWorthy.expectedUpliftPct >= GRADE_UP_MIN_UPLIFT_PCT
    && inp.gradeWorthy.confidence !== "low"
    && inp.gradeWorthy.expectedNetUplift > 0;

  if (gradeUpFires) {
    const upliftFraction = Math.min(4, inp.gradeWorthy!.expectedUpliftPct); // cap at 4× for scoring
    const confBoost = inp.gradeWorthy!.confidence === "high" ? 10 : 0;
    const rawUrgency = 40 + Math.min(20, upliftFraction * 5) + confBoost;
    const urgency = clamp(rawUrgency, URGENCY_RANGES.GRADE_UP[0], URGENCY_RANGES.GRADE_UP[1]);
    const targetGraded = marketValue !== null && inp.gradeWorthy!.expectedNetUplift > 0
      ? Math.round((marketValue + inp.gradeWorthy!.expectedNetUplift) * 100) / 100
      : null;
    return {
      verdict: "GRADE_UP",
      urgency,
      reason:
        `Send to ${inp.gradeWorthy!.bestTier}`
        + ` · expected +$${inp.gradeWorthy!.expectedNetUplift.toFixed(0)} after cost`
        + ` (${(inp.gradeWorthy!.expectedUpliftPct * 100).toFixed(0)}%)`,
      priceTarget: targetGraded,
      windowClosesIn: null,
    };
  }

  // ── LIST_HIGHER gate ─────────────────────────────────────────────────
  // Predicted meaningfully above current asking (or FMV if unlisted)
  const currentAnchor =
    typeof inp.currentAskingPrice === "number" && inp.currentAskingPrice > 0
      ? inp.currentAskingPrice
      : marketValue;
  const listHigherFires =
    !inp.isGuestimate
    && predictedPrice !== null
    && currentAnchor !== null
    && predictedPrice / currentAnchor - 1 >= LIST_HIGHER_GAP_PCT;

  if (listHigherFires) {
    const gapPct = predictedPrice! / currentAnchor! - 1;
    const rawUrgency = 25 + Math.min(30, gapPct * 100);
    const urgency = clamp(rawUrgency, URGENCY_RANGES.LIST_HIGHER[0], URGENCY_RANGES.LIST_HIGHER[1]);
    return {
      verdict: "LIST_HIGHER",
      urgency,
      reason:
        `Predicted $${predictedPrice!.toFixed(0)}`
        + ` vs current ${
          inp.currentAskingPrice ? "list" : "FMV"
        } $${currentAnchor!.toFixed(0)}`
        + ` (+${(gapPct * 100).toFixed(0)}%)`,
      priceTarget: Math.round(predictedPrice! * 100) / 100,
      windowClosesIn: null,
    };
  }

  // ── WAIT_TO_LIST gate ───────────────────────────────────────────────
  // Matched-cohort weekly rate up but velocity too thin for SELL_NOW
  const waitFires =
    !inp.isGuestimate
    && typeof inp.matchedCohortWeeklyRate === "number"
    && inp.matchedCohortWeeklyRate! > 0.05;   // >5%/wk

  if (waitFires) {
    const rate = inp.matchedCohortWeeklyRate!;
    const rawUrgency = 10 + Math.min(20, rate * 30);
    const urgency = clamp(rawUrgency, URGENCY_RANGES.WAIT_TO_LIST[0], URGENCY_RANGES.WAIT_TO_LIST[1]);
    return {
      verdict: "WAIT_TO_LIST",
      urgency,
      reason:
        `Player trending +${(rate * 100).toFixed(0)}%/wk`
        + ` · thin volume — wait for velocity`,
      priceTarget: predictedPrice !== null ? Math.round(predictedPrice * 100) / 100 : null,
      windowClosesIn: null,
    };
  }

  // ── HOLD (default) ──────────────────────────────────────────────────
  return {
    verdict: "HOLD",
    urgency: 0,
    reason:
      inp.isGuestimate
        ? "No comps yet — engine is estimating from family multipliers"
        : "No strong signal today",
    priceTarget: null,
    windowClosesIn: null,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// Test surfaces
export const _URGENCY_RANGES = URGENCY_RANGES;
export const _SELL_NOW_VELOCITY_MIN = SELL_NOW_VELOCITY_MIN;
export const _SELL_NOW_MOMENTUM_MIN = SELL_NOW_MOMENTUM_MIN;
export const _CASCADE_FRESH_DAYS = CASCADE_FRESH_DAYS;
export const _LIST_HIGHER_GAP_PCT = LIST_HIGHER_GAP_PCT;
export const _GRADE_UP_MIN_UPLIFT_PCT = GRADE_UP_MIN_UPLIFT_PCT;
