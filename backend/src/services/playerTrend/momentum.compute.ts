/**
 * Pure momentum computation from normalized weekly buckets.
 *
 * Vendor-agnostic: takes NormalizedWeeklySales[] and returns
 * PlayerMomentumSignal. Providers (CardHedge today, eBay-direct tomorrow)
 * call this after normalizing their native shape.
 *
 * Ports the logic from compiqEstimate.deriveSalesMomentum but operates on
 * the provider-neutral NormalizedWeeklySales shape (which no longer
 * carries a `partial` flag — providers filter partials on the boundary).
 */

import type {
  NormalizedWeeklySales,
  PlayerMomentumSignal,
} from "./playerTrend.types.js";

const DEFAULT_PRIOR_WEEK_COUNT = 4;

export function computeMomentumFromNormalizedWeeks(
  weeks: ReadonlyArray<NormalizedWeeklySales>,
  priorWeekWindow: number = DEFAULT_PRIOR_WEEK_COUNT,
): PlayerMomentumSignal {
  const empty: PlayerMomentumSignal = {
    latestCompleteWeek: null,
    priorMeanAvgSale: null,
    priorMeanCount: null,
    priorWeeksCount: 0,
    momentumRatio: null,
    volumeRatio: null,
  };
  if (!weeks || weeks.length < 2) return empty;

  const latest = weeks[weeks.length - 1];
  const prior = weeks.slice(0, -1).slice(-Math.max(1, priorWeekWindow));
  if (prior.length === 0) return empty;

  const sumAvg = prior.reduce((s, w) => s + w.avgSale, 0);
  const sumCount = prior.reduce((s, w) => s + w.count, 0);
  const priorMeanAvgSale = sumAvg / prior.length;
  const priorMeanCount = sumCount / prior.length;

  return {
    latestCompleteWeek: latest,
    priorMeanAvgSale: roundCents(priorMeanAvgSale),
    priorMeanCount: Math.round(priorMeanCount),
    priorWeeksCount: prior.length,
    momentumRatio:
      priorMeanAvgSale > 0 ? round3(latest.avgSale / priorMeanAvgSale) : null,
    volumeRatio: priorMeanCount > 0 ? round3(latest.count / priorMeanCount) : null,
  };
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
