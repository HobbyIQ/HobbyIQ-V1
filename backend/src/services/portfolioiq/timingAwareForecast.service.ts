// CF-TIMING-FORECAST (Drew, 2026-07-17). Pure math for the 30-days-out
// price forecast. Combines:
//   - card-side trend (log-price regression from localCompStore)
//   - player-level matched-cohort momentum (stratified raw/graded)
//   - velocity signal (hot / normal / cold vs player baseline)
//
// Formula:
//   anchor = card.projectedNextSalePrice ?? card.latestPrice ?? 0
//   card_month_multiplier = exp(slopePerDay * 30)
//   player_multiplier     = 1 + (playerMomentumUsed - 1) * PLAYER_WEIGHT
//   predictedPrice        = anchor * card_month_multiplier * player_multiplier
//   range width           = volatility * sqrt(horizon / 30)
//   low  = predictedPrice * (1 - range width)
//   high = predictedPrice * (1 + range width)
//
// Confidence:
//   high   = card windowSales >= 20 AND player has stratified data AND no flags
//   medium = at least card OR player data, moderate n
//   low    = only one signal, low n
//   insufficient = no card AND no player data
//
// Key design choice: the player-multiplier is DAMPENED (weight 0.4) because
// player-level trend is diffused across their whole catalog. Card-side
// slope is the primary signal for THIS SKU.

import type {
  CardTrendInputs,
  PlayerTrendInputs,
  TimingForecastInputs,
  TimingForecastResult,
} from "../../types/timingForecast.types.js";

const PLAYER_MOMENTUM_WEIGHT = 0.4;         // 40% pass-through
const VELOCITY_HOT_MULTIPLE = 2.0;          // ≥ 2× baseline = hot
const VELOCITY_COLD_MULTIPLE = 0.5;         // ≤ 0.5× baseline = cold
const MIN_ANCHOR_PRICE = 0.01;              // guard against zero-price cascade
const DEFAULT_HORIZON_DAYS = 30;

const MIN_WINDOW_FOR_HIGH_CONF = 20;
const MIN_WINDOW_FOR_MEDIUM_CONF = 8;

export function computeTimingAwareForecast(
  inputs: TimingForecastInputs,
): TimingForecastResult {
  const horizon = inputs.horizonDays ?? DEFAULT_HORIZON_DAYS;

  // Fast bail — no card AND no player data → insufficient
  if (!inputs.cardTrend && !inputs.playerTrend) {
    return {
      predictedPrice: 0,
      priceRange: { low: 0, high: 0 },
      confidence: "insufficient",
      horizonDays: horizon,
      contributingSignals: {
        cardTrendSlopePerMonthPct: null,
        playerMomentumUsed: null,
        playerMomentumSource: "none",
        velocitySignal: "unknown",
        volatility: null,
        windowSales: null,
      },
      reason: "No card-side trend or player-level trend available",
    };
  }

  const anchor = deriveAnchor(inputs.cardTrend);
  if (anchor <= MIN_ANCHOR_PRICE) {
    return {
      predictedPrice: 0,
      priceRange: { low: 0, high: 0 },
      confidence: "insufficient",
      horizonDays: horizon,
      contributingSignals: {
        cardTrendSlopePerMonthPct: null,
        playerMomentumUsed: null,
        playerMomentumSource: "none",
        velocitySignal: "unknown",
        volatility: null,
        windowSales: null,
      },
      reason: "No usable price anchor from card-side data",
    };
  }

  const slopePerDay = inputs.cardTrend?.slopePerDay ?? 0;
  const cardMonthMultiplier = Math.exp(slopePerDay * horizon);

  const { playerMomentumUsed, playerMomentumSource } = pickPlayerMomentum(
    inputs.playerTrend,
    inputs.currentGraderTier,
  );
  const playerMultiplier = playerMomentumUsed !== null
    ? 1 + (playerMomentumUsed - 1) * PLAYER_MOMENTUM_WEIGHT
    : 1;

  const predictedPriceRaw = anchor * cardMonthMultiplier * playerMultiplier;
  const predictedPrice = round(predictedPriceRaw, 2);

  const volatility = inputs.cardTrend?.volatility ?? 0.15;
  const rangeWidth = volatility * Math.sqrt(horizon / 30);
  const priceRange = {
    low: round(Math.max(0, predictedPriceRaw * (1 - rangeWidth)), 2),
    high: round(predictedPriceRaw * (1 + rangeWidth), 2),
  };

  const velocitySignal = classifyVelocity(
    inputs.skuVelocityPerWeek,
    inputs.playerTrend?.playerVelocityPerWeek,
  );

  const confidence = scoreConfidence(inputs, playerMomentumSource);

  return {
    predictedPrice,
    priceRange,
    confidence,
    horizonDays: horizon,
    contributingSignals: {
      cardTrendSlopePerMonthPct: inputs.cardTrend
        ? round((Math.exp(slopePerDay * 30) - 1) * 100, 1)
        : null,
      playerMomentumUsed,
      playerMomentumSource,
      velocitySignal,
      volatility,
      windowSales: inputs.cardTrend?.windowSales ?? null,
    },
    reason: buildReason(inputs, confidence, playerMomentumSource, velocitySignal),
  };
}

function deriveAnchor(card: CardTrendInputs | null): number {
  if (!card) return 0;
  if (card.projectedNextSalePrice && card.projectedNextSalePrice > 0) return card.projectedNextSalePrice;
  if (card.latestPrice && card.latestPrice > 0) return card.latestPrice;
  return 0;
}

function pickPlayerMomentum(
  player: PlayerTrendInputs | null,
  graderTier: string,
): { playerMomentumUsed: number | null; playerMomentumSource: "raw" | "graded" | "all" | "none" } {
  if (!player) return { playerMomentumUsed: null, playerMomentumSource: "none" };
  const isRawHolding = !graderTier || graderTier.toLowerCase() === "raw";
  const preferred = isRawHolding ? player.rawMomentum : player.gradedMomentum;
  if (preferred !== null && preferred !== undefined) {
    return { playerMomentumUsed: preferred, playerMomentumSource: isRawHolding ? "raw" : "graded" };
  }
  return { playerMomentumUsed: player.allMomentum, playerMomentumSource: "all" };
}

function classifyVelocity(
  skuVelocity: number,
  playerBaseline: number | null | undefined,
): "hot" | "normal" | "cold" | "unknown" {
  if (!playerBaseline || playerBaseline <= 0) return "unknown";
  // We approximate baseline for a single SKU as `player velocity / typical
  // catalog size`. But with the SKU velocity as an absolute-per-SKU
  // number, we compare against a per-SKU proxy: use the player's per-week
  // rate as a naive baseline. If the SKU is trading at ≥ 2× the "average
  // card of this player", flag hot.
  const perSkuBaseline = playerBaseline / 20; // approximate 20 SKUs per active player
  if (skuVelocity >= perSkuBaseline * VELOCITY_HOT_MULTIPLE) return "hot";
  if (skuVelocity <= perSkuBaseline * VELOCITY_COLD_MULTIPLE) return "cold";
  return "normal";
}

function scoreConfidence(
  inputs: TimingForecastInputs,
  playerMomentumSource: "raw" | "graded" | "all" | "none",
): "high" | "medium" | "low" | "insufficient" {
  const cardN = inputs.cardTrend?.windowSales ?? 0;
  const hasPlayer = playerMomentumSource !== "none";
  const playerHasStratified = playerMomentumSource === "raw" || playerMomentumSource === "graded";
  const playerFlagsHavePenalty = (inputs.playerTrend?.playerFlags ?? []).some(
    (f) => f === "sparse" || f === "wide_ratio_dispersion",
  );

  if (cardN >= MIN_WINDOW_FOR_HIGH_CONF && hasPlayer && playerHasStratified && !playerFlagsHavePenalty) {
    return "high";
  }
  if (cardN >= MIN_WINDOW_FOR_MEDIUM_CONF && hasPlayer) return "medium";
  if (cardN > 0 || hasPlayer) return "low";
  return "insufficient";
}

function buildReason(
  inputs: TimingForecastInputs,
  confidence: string,
  playerSource: "raw" | "graded" | "all" | "none",
  velocity: string,
): string {
  const parts: string[] = [];
  if (inputs.cardTrend && inputs.cardTrend.windowSales > 0) {
    const slopePct = round((Math.exp(inputs.cardTrend.slopePerDay * 30) - 1) * 100, 1);
    parts.push(`card slope ${slopePct >= 0 ? "+" : ""}${slopePct}%/mo (n=${inputs.cardTrend.windowSales})`);
  }
  if (playerSource !== "none" && inputs.playerTrend) {
    const momentum = playerSource === "raw" ? inputs.playerTrend.rawMomentum
      : playerSource === "graded" ? inputs.playerTrend.gradedMomentum
      : inputs.playerTrend.allMomentum;
    const pct = momentum !== null ? round((momentum - 1) * 100, 1) : null;
    if (pct !== null) parts.push(`player ${playerSource} ${pct >= 0 ? "+" : ""}${pct}%`);
  }
  if (velocity === "hot") parts.push("velocity hot");
  if (velocity === "cold") parts.push("velocity cold");
  const body = parts.join(", ");
  return body ? `${confidence} confidence: ${body}` : `${confidence} confidence`;
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

// Test surfaces.
export const _PLAYER_MOMENTUM_WEIGHT = PLAYER_MOMENTUM_WEIGHT;
export const _VELOCITY_HOT_MULTIPLE = VELOCITY_HOT_MULTIPLE;
export const _VELOCITY_COLD_MULTIPLE = VELOCITY_COLD_MULTIPLE;
export const _MIN_WINDOW_FOR_HIGH_CONF = MIN_WINDOW_FOR_HIGH_CONF;
export const _MIN_WINDOW_FOR_MEDIUM_CONF = MIN_WINDOW_FOR_MEDIUM_CONF;
