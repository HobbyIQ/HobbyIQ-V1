// CF-PORTFOLIO-MOMENTUM (Drew, 2026-07-17). Pure aggregation math.
// Joins holdings with player_trends and emits portfolio-level momentum
// + up/flat/down bucket counts + top movers.

import type {
  PortfolioMomentumHoldingInput,
  PortfolioMomentumPlayerTrend,
  PortfolioMomentumOptions,
  PortfolioMomentumResult,
  PortfolioMomentumMoverEntry,
} from "../../types/portfolioMomentum.types.js";

const DEFAULTS: Required<PortfolioMomentumOptions> = {
  upThreshold: 1.05,
  downThreshold: 0.95,
  topMoversCount: 3,
};

export function computePortfolioMomentum(
  holdings: PortfolioMomentumHoldingInput[],
  playerTrendsByName: Map<string, PortfolioMomentumPlayerTrend>,
  opts: PortfolioMomentumOptions = {},
  now: Date = new Date(),
): PortfolioMomentumResult {
  const options = { ...DEFAULTS, ...opts };
  const { upThreshold, downThreshold, topMoversCount } = options;

  let sumWeightedMomentum = 0;
  let sumWeight = 0;
  let sumUnweightedMomentum = 0;
  let holdingsWithTrend = 0;
  let cardsUp = 0;
  let cardsFlat = 0;
  let cardsDown = 0;
  let cardsUntracked = 0;
  let impliedDelta = 0;
  let impliedDeltaAvailable = false;

  const movers: PortfolioMomentumMoverEntry[] = [];

  for (const h of holdings) {
    const trend = h.playerName ? playerTrendsByName.get(h.playerName) : undefined;
    if (!trend) {
      cardsUntracked++;
      continue;
    }
    holdingsWithTrend++;
    const momentum = trend.momentum;
    const weight =
      typeof h.currentValue === "number" && Number.isFinite(h.currentValue) && h.currentValue > 0
        ? h.currentValue * Math.max(1, h.quantity)
        : 0;
    sumWeightedMomentum += momentum * weight;
    sumWeight += weight;
    sumUnweightedMomentum += momentum;

    if (momentum >= upThreshold) cardsUp++;
    else if (momentum <= downThreshold) cardsDown++;
    else cardsFlat++;

    // impliedDelta = Σ (currentValue × (momentum - 1))
    if (weight > 0) {
      impliedDelta += weight * (momentum - 1);
      impliedDeltaAvailable = true;
    }

    movers.push({
      holdingId: h.holdingId,
      playerName: h.playerName ?? trend.playerName,
      momentum: round(momentum, 4),
      direction: trend.direction,
      contributionUsd: weight > 0 ? round(weight * (momentum - 1), 2) : null,
    });
  }

  const portfolioMomentum = holdingsWithTrend === 0
    ? 1
    : sumWeight > 0
      ? sumWeightedMomentum / sumWeight
      : sumUnweightedMomentum / holdingsWithTrend;

  const direction: "up" | "flat" | "down" =
    portfolioMomentum >= upThreshold ? "up" :
    portfolioMomentum <= downThreshold ? "down" :
    "flat";

  // top / worst movers by absolute momentum delta
  const topMovers = movers
    .filter((m) => m.direction === "up")
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, topMoversCount);
  const worstMovers = movers
    .filter((m) => m.direction === "down")
    .sort((a, b) => a.momentum - b.momentum)
    .slice(0, topMoversCount);

  return {
    computedAt: now.toISOString(),
    scannedHoldings: holdings.length,
    holdingsWithTrend,
    portfolioMomentum: round(portfolioMomentum, 4),
    direction,
    cardsUp,
    cardsFlat,
    cardsDown,
    cardsUntracked,
    topMovers,
    worstMovers,
    impliedPortfolioDelta: impliedDeltaAvailable ? round(impliedDelta, 2) : null,
  };
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

export const _DEFAULTS = DEFAULTS;
