/**
 * CF-ACTION-RECOMMENDATION (2026-07-05, Drew):
 *
 * The product surface for tonight's engine work. Consumes the
 * signals we've refined all evening — pill, Market Value, Predicted,
 * confidence, signalSource, weeksSinceRelease — and emits a single
 * actionable verdict per card/grade/holding: SELL_NOW, HOLD, LIST,
 * or INSUFFICIENT_DATA.
 *
 * From memory (`project_product_actionable_seller_intelligence`):
 * "HobbyIQ's value prop is timed action recommendations
 * (sell/hold/list) using cascade-detected head-start windows, NOT
 * prediction accuracy." All the accuracy work funnels into this
 * surface — it's what the seller actually sees and decides on.
 *
 * Pure function. No I/O. Deterministic given the inputs. Trivial to
 * test, cheap to call thousands of times per portfolio-repricing
 * pass. Callers wire the outputs onto per-grade entries (card-panel)
 * and per-holding rows (portfolio).
 */

export type ActionVerdict =
  | "SELL_NOW"
  | "HOLD"
  | "LIST"
  | "INSUFFICIENT_DATA";

export type ActionUrgency = "high" | "medium" | "low" | null;

export interface ActionInputs {
  /** Market Value TODAY. Null → INSUFFICIENT_DATA. */
  currentValue: number | null;
  /** Predicted at the forecast horizon (7d as of 2026-07-06; the
   *  wire field is `predictedPriceAt30d` for backward-compat but the
   *  actual value now covers 7 days forward). Null → INSUFFICIENT_DATA. */
  predictedValue: number | null;
  /** 0–1 confidence. <0.20 → INSUFFICIENT_DATA regardless of gap. */
  confidenceScore: number;
  /** Which trajectory signal drove Predicted. When "release-decay-blend"
   *  AND early in the decay window, we tilt toward LIST-ahead-of-decay
   *  even if the raw gap wouldn't warrant SELL_NOW. */
  signalSource: string | null;
  /** Weeks since product release. Only meaningful when signalSource
   *  includes release-decay. */
  weeksSinceRelease?: number | null;
  /** Optional — user's cost basis for this holding. Included in the
   *  reasoning string when SELL_NOW would realize a loss vs cost. */
  costBasis?: number | null;
}

export interface ActionRecommendation {
  verdict: ActionVerdict;
  /** Suggested list price when verdict === "LIST". Null otherwise. */
  targetPrice: number | null;
  /** Short human-readable "why" — surfaced on iOS as a caption. */
  reasoning: string;
  /** UI treatment hint. High = red/orange emphasis; medium = neutral;
   *  low = green/calm; null = grey (INSUFFICIENT_DATA). */
  urgency: ActionUrgency;
  /** Percentage delta between Predicted and current. Positive = rising.
   *  Null when either side isn't available. */
  expectedDeltaPct: number | null;
}

/** Confidence floor below which we NEVER emit a directional verdict.
 *  Below this, the pool is too thin to trust either way — even a huge
 *  Predicted gap could be noise. */
const CONFIDENCE_FLOOR = 0.20;
/** Confidence required to fire HOLD (rising). Higher bar because
 *  telling a seller to hold IS a decision that costs them time. */
const HOLD_CONFIDENCE_THRESHOLD = 0.60;
/** Confidence required to fire SELL_NOW (falling). Slightly lower bar
 *  than HOLD because a SELL that's wrong costs less than a HOLD that's
 *  wrong (missed sale beats holding a bag). */
const SELL_CONFIDENCE_THRESHOLD = 0.40;
/** Gap thresholds — how big does Predicted need to be vs current
 *  to warrant a verdict? Scaled down 2026-07-06 from ±15% → ±5% to
 *  match the horizon shortening from 30 → 7 days. Same underlying
 *  rate that fired HOLD/SELL_NOW at 30d would never fire at 7d
 *  without this rescale — a +10%/wk rate projects as +42% over 30
 *  days (well above the old 15% threshold) but only +10% over 7 days.
 *  ±5% catches ~22%/wk annualized moves, which is still a meaningful
 *  hot/cold signal worth acting on. */
const HOLD_GAP_UP = 0.05;    // Predicted > current × 1.05 → HOLD
const SELL_GAP_DOWN = -0.05; // Predicted < current × 0.95 → SELL_NOW
/** Early-decay list-ahead window. If the card is inside its first
 *  DECAY_URGENCY_WEEKS post-release AND on the decay-blend signal,
 *  we recommend LIST NOW at a slight discount (LIST-under-market) to
 *  get out ahead of steeper decay. */
const DECAY_URGENCY_WEEKS = 4;
const DECAY_URGENCY_UNDERCUT = 0.05; // list at 95% of current
/** Fair-value listing spread. When we recommend LIST at a fair price,
 *  target slightly ABOVE Predicted so there's negotiating headroom
 *  (best-offer buyers routinely undercut asking by 3–7%). */
const LIST_MARKUP_OVER_PREDICTED = 0.02;
const LIST_MARKUP_OVER_CURRENT = 0.03;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute the recommendation for a single (grade/holding) row.
 *
 * Order-of-operations:
 *   1. Guard for missing data — INSUFFICIENT_DATA if any critical
 *      input is null or confidence is below the floor.
 *   2. Compute expectedDeltaPct once, reuse throughout.
 *   3. Rising strongly with confidence → HOLD
 *   4. Falling strongly with confidence → SELL_NOW
 *   5. Early-decay-window override → LIST at undercut
 *   6. Everything else → LIST at fair-value markup
 */
export function computeAction(inputs: ActionInputs): ActionRecommendation {
  const {
    currentValue,
    predictedValue,
    confidenceScore,
    signalSource,
    weeksSinceRelease,
    costBasis,
  } = inputs;

  // Step 1: guard rails
  if (
    currentValue === null ||
    currentValue <= 0 ||
    predictedValue === null ||
    predictedValue <= 0 ||
    confidenceScore < CONFIDENCE_FLOOR
  ) {
    return {
      verdict: "INSUFFICIENT_DATA",
      targetPrice: null,
      reasoning: "Not enough recent sales to make a call.",
      urgency: null,
      expectedDeltaPct: null,
    };
  }

  // Step 2: single delta computation
  const deltaPct = predictedValue / currentValue - 1;
  const roundedDeltaPct = round2(deltaPct * 100);

  // Step 3: strong rise + confidence → HOLD
  if (deltaPct >= HOLD_GAP_UP && confidenceScore >= HOLD_CONFIDENCE_THRESHOLD) {
    return {
      verdict: "HOLD",
      targetPrice: null,
      reasoning: `Trend points up ~${roundedDeltaPct}% over 7d. Hold for a better window.`,
      urgency: "low",
      expectedDeltaPct: roundedDeltaPct,
    };
  }

  // Step 4: strong fall + confidence → SELL_NOW
  if (deltaPct <= SELL_GAP_DOWN && confidenceScore >= SELL_CONFIDENCE_THRESHOLD) {
    const lossVsCost =
      costBasis && costBasis > 0 && predictedValue < costBasis
        ? ` — projected below your cost basis of $${round2(costBasis)}`
        : "";
    return {
      verdict: "SELL_NOW",
      targetPrice: null,
      reasoning: `Trend points down ~${Math.abs(roundedDeltaPct)}% over 7d${lossVsCost}. Cut before further decline.`,
      urgency: "high",
      expectedDeltaPct: roundedDeltaPct,
    };
  }

  // Step 5: early-decay window override — LIST NOW at undercut so the
  // holder gets out before the steeper part of the decay curve hits.
  const inEarlyDecay =
    typeof signalSource === "string" &&
    signalSource.startsWith("release-decay") &&
    typeof weeksSinceRelease === "number" &&
    weeksSinceRelease < DECAY_URGENCY_WEEKS;

  if (inEarlyDecay) {
    const target = round2(currentValue * (1 - DECAY_URGENCY_UNDERCUT));
    return {
      verdict: "LIST",
      targetPrice: target,
      reasoning: `New-release supply still building. List at $${target} to move it before decay steepens.`,
      urgency: "high",
      expectedDeltaPct: roundedDeltaPct,
    };
  }

  // Step 6: fair-value LIST — use the higher of Predicted-markup or
  // current-markup so we never suggest listing BELOW today's market.
  const targetFromPredicted = predictedValue * (1 + LIST_MARKUP_OVER_PREDICTED);
  const targetFromCurrent = currentValue * (1 + LIST_MARKUP_OVER_CURRENT);
  const target = round2(Math.max(targetFromPredicted, targetFromCurrent));
  const directionCopy =
    deltaPct >= 0.02
      ? `up ~${roundedDeltaPct}%`
      : deltaPct <= -0.02
        ? `down ~${Math.abs(roundedDeltaPct)}%`
        : "flat";
  return {
    verdict: "LIST",
    targetPrice: target,
    reasoning: `Trend ${directionCopy} over 7d. List at $${target} for headroom.`,
    urgency: "medium",
    expectedDeltaPct: roundedDeltaPct,
  };
}
