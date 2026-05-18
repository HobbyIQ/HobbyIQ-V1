// DailyIQ movement badge. Translates a player's dailyScore vs a rolling
// baseline (and optionally a card market-comp delta) into a labeled direction
// badge that the iOS UI renders distinctly from the existing player card.
//
// Thresholds (performanceDelta = (score - baseline) / max(baseline, 1)):
//   Breakout Alert  score >= 2*baseline AND score >= 15
//   Stock Up        delta >= +0.50
//   Rising          +0.20 <= delta < +0.50
//   Cooling         -0.50 < delta <= -0.20
//   Stock Down      delta <= -0.50
//   No Change       otherwise

export interface MovementInput {
  score: number;
  baseline: number;
  marketDelta?: {
    pct1d: number;
    pct7d: number;
    pct30d: number;
    avg30dPrice?: number;
    sampleCount?: number;
  } | null;
}

export interface Movement {
  direction: "up" | "down" | "neutral";
  label: string;
  reason: string;
  performanceDelta: number;
  marketDelta?: MovementInput["marketDelta"];
}

const BREAKOUT_MULTIPLIER = 2;
const BREAKOUT_MIN_SCORE = 15;
const STOCK_UP = 0.5;
const RISING = 0.2;
const COOLING = -0.2;
const STOCK_DOWN = -0.5;

export function computeMovement(input: MovementInput): Movement {
  const baseline = Math.max(input.baseline, 0);
  const score = Math.max(input.score, 0);
  const denom = Math.max(baseline, 1);
  const performanceDelta = (score - baseline) / denom;

  // Breakout Alert takes precedence over everything else.
  if (score >= BREAKOUT_MIN_SCORE && (baseline === 0 || score >= baseline * BREAKOUT_MULTIPLIER)) {
    return {
      direction: "up",
      label: "Breakout Alert",
      reason: `Score ${score.toFixed(1)} is ${baseline > 0 ? `${(score / baseline).toFixed(1)}\u00d7 baseline` : "well above expectation"}`,
      performanceDelta,
      marketDelta: input.marketDelta ?? null,
    };
  }

  let label = "No Change";
  let direction: Movement["direction"] = "neutral";
  let reason = `Performance in line with ${baseline.toFixed(1)} baseline`;

  if (performanceDelta >= STOCK_UP) {
    label = "Stock Up";
    direction = "up";
    reason = `+${(performanceDelta * 100).toFixed(0)}% above baseline`;
  } else if (performanceDelta >= RISING) {
    label = "Rising";
    direction = "up";
    reason = `+${(performanceDelta * 100).toFixed(0)}% above baseline`;
  } else if (performanceDelta <= STOCK_DOWN) {
    label = "Stock Down";
    direction = "down";
    reason = `${(performanceDelta * 100).toFixed(0)}% below baseline`;
  } else if (performanceDelta <= COOLING) {
    label = "Cooling";
    direction = "down";
    reason = `${(performanceDelta * 100).toFixed(0)}% below baseline`;
  }

  // If we have a confirming card-market signal, fold it into the reason text
  // so the UI can show a single coherent line.
  if (input.marketDelta) {
    const m = input.marketDelta;
    if (Math.abs(m.pct7d) >= 5) {
      const arrow = m.pct7d >= 0 ? "+" : "";
      reason += ` \u2022 card ${arrow}${m.pct7d.toFixed(1)}% / 7d`;
    }
  }

  return {
    direction,
    label,
    reason,
    performanceDelta,
    marketDelta: input.marketDelta ?? null,
  };
}
