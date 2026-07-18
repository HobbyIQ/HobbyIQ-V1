// CF-NO-MEDIAN-FMV (Drew, 2026-07-15): projected-next-sale helper.
//
// Design principle (Drew, 2026-07-15): FMV = projected NEXT sale from the
// pool's trend, never a median/mean of past comps. This helper is the
// canonical implementation; every FMV-emitting fallback in the pricing
// engine should route through it instead of computing its own median.
//
// Method ladder (STRICT — never falls back to median):
//   1. `linear-regression`  — n≥2 comps with ≥2 distinct dates.
//      Reuses `computeSlopeValuation` (fits OLS on dated points and
//      evaluates at now+30d). This is the honest "next sale" projection.
//   2. `trend-adjusted-last-sale` — n≥1 dated comp but regression can't
//      fit (n=1 OR all-same-date). Anchor on the most-recent dated sale
//      and roll it forward using `broaderTrendPctPerMonth` (playerMomentum
//      / matchedCohort / trendIQ) supplied by the caller. When no broader
//      trend is available (opts.broaderTrendPctPerMonth = null / 0), the
//      anchor sale rolls forward unchanged — still the most honest single-
//      point projection available.
//   3. `null` — n=0 or no positive-priced comps. Honest null; downstream
//      renders the "no basis" state instead of a fabricated number.
//
// What this helper NEVER does:
//   - Return a median or mean as `nextSaleValue`.
//   - Silently drop the trend signal from a fittable pool.
//   - Extrapolate more than the pool actually supports (spread widens on
//     low n / low broader-trend confidence).
//
// See feedback_no_medians_project_next_sale.md for the design principle
// and the 2026-07-15 audit that catalogued the 9 median-as-FMV sites this
// helper replaces.

import { computeSlopeValuation } from "./slopeValuation.js";

export interface DatedComp {
  /** Realized sale price. Non-positive / non-finite values are dropped. */
  price: number;
  /** ISO-8601 or any Date.parse-able string. null/absent → not usable for regression. */
  soldDate?: string | null;
}

export interface NextSaleProjectionOptions {
  /**
   * Broader-trend signal (% per month) used ONLY in the trend-adjusted-
   * last-sale fallback branch. Sources: playerMomentum monthly delta,
   * matchedCohort medianRatio annualized to monthly, trendIQ composite.
   * null or 0 → anchor sale rolls forward unchanged.
   */
  broaderTrendPctPerMonth?: number | null;
  /** Injectable clock for tests. Production omits. */
  nowMs?: number;
  /**
   * How many months forward to project. Defaults to 1 ("next sale").
   * Callers projecting further out (30/60/90d windows) can override.
   */
  monthsForward?: number;
  /**
   * CF-FORWARD-WINDOW-CONFIGURABLE (Drew, 2026-07-18): forward
   * projection window in DAYS for the linear-regression branch.
   * Takes precedence over monthsForward's implicit 30d when set.
   * Canonical FMV passes 3 for a "next sale today" projection instead
   * of the legacy 30d extrapolation. Default preserves 30d back-compat.
   */
  forwardDays?: number;
}

export type NextSaleMethod =
  | "linear-regression"
  | "trend-adjusted-last-sale";

export interface NextSaleProjection {
  /** The projected next sale price. Always a positive finite number. */
  nextSaleValue: number;
  /** Which branch of the method ladder fired. */
  method: NextSaleMethod;
  /** Count of positive-priced comps considered. */
  n: number;
  /** 0–1. Higher for regression fits with more samples. */
  confidence: number;
  /** Reported monthly slope %, or the broader-trend % when the fallback fired. */
  slopePerMonthPct: number;
  /** Range around `nextSaleValue`; widens on low sample counts / weak trend. */
  bounds: { low: number; high: number };
}

const MS_PER_DAY = 86_400_000;

/**
 * Project the next likely sale price from a dated comp pool.
 *
 * Returns null when the pool has zero usable priced comps. Downstream
 * callers surface null as "no basis to price" — DO NOT substitute a
 * median or mean.
 */
export function projectNextSaleFromComps(
  comps: ReadonlyArray<DatedComp>,
  opts: NextSaleProjectionOptions = {},
): NextSaleProjection | null {
  if (!comps || comps.length === 0) return null;

  const priced = comps.filter(
    (c) => Number.isFinite(c.price) && c.price > 0,
  );
  if (priced.length === 0) return null;

  const nowMs = opts.nowMs ?? Date.now();
  const monthsForward = opts.monthsForward ?? 1;

  // Branch 1: linear-regression when n≥2 with distinct dates.
  // Forward-window: opts.forwardDays wins; else convert monthsForward
  // (default 1 month) to days for computeSlopeValuation.
  const forwardDays = opts.forwardDays ?? Math.round(monthsForward * 30);
  const slopeVal = computeSlopeValuation(
    priced.map((c) => ({ date: c.soldDate ?? null, price: c.price })),
    nowMs,
    forwardDays,
  );
  // Guard against regression extrapolations that collapse to zero — a
  // sharp downtrend can drive marketValue×(1 + slope×30d) into the negative
  // domain, which computeSlopeValuation floors at zero. A zero projection
  // is worse than an honest thin-market fall-through: fall through to the
  // trend-adjusted-last-sale branch when this happens.
  if (slopeVal && slopeVal.predictedPrice > 0) {
    return {
      nextSaleValue: slopeVal.predictedPrice,
      method: "linear-regression",
      n: slopeVal.n,
      confidence: confidenceForN(slopeVal.n),
      slopePerMonthPct: slopeVal.slopePerMonthPct,
      bounds: slopeVal.predictedPriceRange,
    };
  }

  // Branch 2: trend-adjusted last-sale. Anchor on the newest dated comp
  // (fall back to the array's last positively-priced comp when no dates
  // survive — this branch fires when the caller has no soldDate info).
  const dated = priced
    .filter((c) => typeof c.soldDate === "string" && c.soldDate.length > 0)
    .map((c) => ({ price: c.price, tMs: Date.parse(c.soldDate as string) }))
    .filter((p) => Number.isFinite(p.tMs))
    .sort((a, b) => b.tMs - a.tMs);

  const anchor = dated.length > 0
    ? dated[0]
    : { price: priced[priced.length - 1].price, tMs: nowMs };

  const daysAgo = Math.max(0, (nowMs - anchor.tMs) / MS_PER_DAY);
  const monthsAgo = daysAgo / 30;
  const trendPct = opts.broaderTrendPctPerMonth ?? 0;
  // CF-FORWARD-WINDOW-CONFIGURABLE (Drew, 2026-07-18): forwardDays
  // (when set) drives the branch-2 anchor-forward step; else use
  // monthsForward (default 1 month). Canonical FMV passes 3d.
  const forwardMonthsUsed = opts.forwardDays !== undefined
    ? opts.forwardDays / 30
    : monthsForward;
  const totalMonths = monthsAgo + forwardMonthsUsed;
  // Cap the extrapolation window at 6 months of broader-trend applied to a
  // single anchor — beyond that the projection is more noise than signal.
  const cappedMonths = Math.min(totalMonths, 6);
  const trendMultiplier = 1 + (trendPct / 100) * cappedMonths;
  const projectedRaw = anchor.price * trendMultiplier;
  const projected = Math.max(0.01, projectedRaw);

  // Spread widens with (a) how thin the pool is and (b) how uncertain the
  // trend signal is (proxied by |trendPct| — extreme trends are less
  // trustworthy on single-anchor projections).
  const trendUncertainty = Math.min(0.15, Math.abs(trendPct) / 100 * 0.5);
  const baseSpread = priced.length === 1 ? 0.35 : 0.25;
  const spread = baseSpread + trendUncertainty;

  return {
    nextSaleValue: round2(projected),
    method: "trend-adjusted-last-sale",
    n: priced.length,
    // Fallback branch is inherently thin — cap confidence.
    confidence: priced.length === 1 ? 0.2 : 0.3,
    slopePerMonthPct: round1(trendPct),
    bounds: {
      low: Math.max(0.01, round2(projected * (1 - spread))),
      high: round2(projected * (1 + spread)),
    },
  };
}

function confidenceForN(n: number): number {
  if (n >= 20) return 0.85;
  if (n >= 10) return 0.7;
  if (n >= 5) return 0.55;
  return 0.4;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
