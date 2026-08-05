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
   * Canonical FMV passes 0 for a "worth today" projection (no
   * extrapolation), instead of the legacy 30d extrapolation.
   * Default preserves 30d back-compat.
   */
  forwardDays?: number;
  /**
   * CF-MIN-N-FOR-REGRESSION (Drew, 2026-07-18): minimum priced-comps
   * count required to fire the linear-regression branch. Below this,
   * the branch-2 anchor-plus-broader-trend fires instead. At n=2 the
   * OLS line extrapolates unbounded, so a +44%/10-day sample projects
   * a +$520 lift for 13 days back-to-today — mathematically correct,
   * empirically over-aggressive for thin data. Default 2 preserves
   * back-compat; canonical FMV passes 3 to require real cohort depth.
   */
  minNForRegression?: number;
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

// CF-THIN-POOL-SLOPE-CAP (Drew, 2026-07-31). Thresholds for the
// regression-output clamp applied inside branch 1. Chosen from the
// Hartman Orange Shimmer case: 3 sales in 5 days → clamp; 5 sales in
// 30 days → don't clamp. See the extended comment at the clamp site.
const THIN_POOL_N_THRESHOLD = 5;
const SHORT_WINDOW_DAYS_THRESHOLD = 14;
const THIN_POOL_CAP_PCT = 0.25;   // ±25% band around the newest sale
// CF-MEDIAN-ANCHOR-CAP (Drew, 2026-08-05). Even wide pools can have
// outlier sales that pull the regression through wild slopes. Live
// case: Ken Griffey 1999 Topps Chrome LD1 Refractor — 17 raw sales in
// 60d spanning $125-$534, median $306. One $125 outlier at t=59
// pulled the regression to slope ≈ -60%/month, projected $125. Cap
// the projection to ±40% of the pool median so outlier-driven fits
// can't replace the observed clearing price. Trend direction and
// slopePerMonthPct still reported; only the OUTPUT clamps.
// CF-MEDIAN-ANCHOR-CAP-TIGHTEN (Drew, 2026-08-05). Tightened from 0.40
// to 0.25 after Griffey LD1 Refractor case showed \xB140% still let an
// outlier pull FMV visibly below the pool median. \xB125% keeps a real
// price move room to project while hard-blocking outlier-driven
// regression fits.
const MEDIAN_ANCHOR_CAP_PCT = 0.25;

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

  // Branch 1: linear-regression when n≥MIN with distinct dates.
  // Forward-window: opts.forwardDays wins; else convert monthsForward
  // (default 1 month) to days for computeSlopeValuation.
  const forwardDays = opts.forwardDays ?? Math.round(monthsForward * 30);
  const minN = Math.max(2, opts.minNForRegression ?? 2);
  const slopeVal = priced.length >= minN
    ? computeSlopeValuation(
        priced.map((c) => ({ date: c.soldDate ?? null, price: c.price })),
        nowMs,
        forwardDays,
      )
    : null;
  // Guard against regression extrapolations that collapse to zero — a
  // sharp downtrend can drive marketValue×(1 + slope×30d) into the negative
  // domain, which computeSlopeValuation floors at zero. A zero projection
  // is worse than an honest thin-market fall-through: fall through to the
  // trend-adjusted-last-sale branch when this happens.
  if (slopeVal && slopeVal.predictedPrice > 0) {
    // CF-THIN-POOL-SLOPE-CAP (Drew, 2026-07-31). Linear regression on a
    // thin (n<5), short-time-window (<14d) pool fits wild slopes that
    // extrapolate wildly under a 30d forward window. Live 2026-07-31:
    // Hartman Orange Shimmer PSA 10 — 3 raws in 5 days ($1185 → $1531)
    // fit slope +188.96%/month → 30d projection = $3,440 raw × PSA 10
    // multiplier = $9,828. Same card computed with median-anchored math
    // is $2,785. The regression is mathematically fitting the data but
    // the SIGNAL is over-fit noise.
    //
    // Cap the regression's projected value to a ±25% band around the
    // pool's newest sale when BOTH conditions hold. Preserves the trend
    // DIRECTION (still slopes up/down) and slopePerMonthPct as
    // reported, so downstream telemetry sees the raw signal, but the
    // OUTPUT that becomes fmv is clamped so a 5-day snapshot can't
    // triple-guess the next sale.
    let clampedValue = slopeVal.predictedPrice;
    let clampedBounds = slopeVal.predictedPriceRange;
    if (priced.length < THIN_POOL_N_THRESHOLD) {
      const dates = priced
        .map((c) => (c.soldDate ? Date.parse(c.soldDate) : NaN))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
      if (dates.length >= 2) {
        const spanDays = (dates[dates.length - 1] - dates[0]) / MS_PER_DAY;
        if (spanDays < SHORT_WINDOW_DAYS_THRESHOLD) {
          const anchor = priced.reduce((newest, c) => {
            const t = c.soldDate ? Date.parse(c.soldDate) : NaN;
            const nt = newest.soldDate ? Date.parse(newest.soldDate) : NaN;
            return Number.isFinite(t) && (!Number.isFinite(nt) || t > nt) ? c : newest;
          }, priced[0]);
          const anchorPrice = anchor.price;
          const highCap = anchorPrice * (1 + THIN_POOL_CAP_PCT);
          const lowCap = anchorPrice * (1 - THIN_POOL_CAP_PCT);
          clampedValue = Math.min(Math.max(slopeVal.predictedPrice, lowCap), highCap);
          if (clampedValue !== slopeVal.predictedPrice) {
            clampedBounds = {
              low: Math.min(clampedValue, slopeVal.predictedPriceRange.low),
              high: Math.max(clampedValue, slopeVal.predictedPriceRange.high),
            };
          }
        }
      }
    }
    // CF-MEDIAN-ANCHOR-CAP — always-on cap around the pool median.
    // Applies AFTER the thin-pool cap so both bounds get their say.
    const pricedByPrice = priced.map((c) => c.price).sort((a, b) => a - b);
    if (pricedByPrice.length > 0) {
      const midIdx = Math.floor(pricedByPrice.length / 2);
      const medianPrice = pricedByPrice.length % 2 === 0
        ? (pricedByPrice[midIdx - 1] + pricedByPrice[midIdx]) / 2
        : pricedByPrice[midIdx];
      const highCap = medianPrice * (1 + MEDIAN_ANCHOR_CAP_PCT);
      const lowCap = medianPrice * (1 - MEDIAN_ANCHOR_CAP_PCT);
      const preCap = clampedValue;
      clampedValue = Math.min(highCap, Math.max(lowCap, clampedValue));
      if (clampedValue !== preCap) {
        clampedBounds = {
          low: Math.min(clampedValue, clampedBounds.low),
          high: Math.max(clampedValue, clampedBounds.high),
        };
      }
    }
    return {
      nextSaleValue: clampedValue,
      method: "linear-regression",
      n: slopeVal.n,
      confidence: confidenceForN(slopeVal.n),
      slopePerMonthPct: slopeVal.slopePerMonthPct,
      bounds: clampedBounds,
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
