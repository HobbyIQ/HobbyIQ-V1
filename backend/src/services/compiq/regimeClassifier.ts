// ---------------------------------------------------------------------------
// Regime Classifier — Issue #25 Phase 1
//
// Pure function that classifies a card's recent sold-comp series into one of
// six market regimes (plus an "insufficient_data" sentinel). This module is
// read-only with respect to the pricing engine: it never mutates anything,
// produces no side effects, and is unit-testable without a server.
//
// Phase 1 contract: the result is surfaced on the API response only. NO
// pricing math reads from this classifier in Phase 1. Later phases will wire
// regime-specific behavior on top of this signal.
//
// Algorithm (per issue #25 Phase 1 design):
//   1. Drop comps without a parseable price or sale date, and any sale
//      outside the trailing 90-day window.
//   2. If < 5 valid comps remain → "insufficient_data".
//   3. Compare last-14d mean vs the 14-90d mean (the "older" bucket).
//        If recent > +15% above older AND ≥ 3 recent sales → "sharply_breaking_out"
//        If recent < -15% below older AND ≥ 3 recent sales → "sharply_crashing"
//   4. Otherwise fit a linear regression price ~ day over the 90-day window:
//        If R² < 0.20:
//           CoV > 0.30  → "volatile"
//           else        → "stable"
//        Else if slope > +2%/month → "gradually_rising"
//        Else if slope < -2%/month → "declining"
//        Else                     → "stable"
//
// Confidence:
//   high   = ≥15 comps and classification is not on a slope boundary
//   medium = ≥10 comps OR slope within ±25% of the ±2%/month boundary
//   low    = 5–9 comps
//   insufficient_data → always "low"
// ---------------------------------------------------------------------------

export type Regime =
  | "stable"
  | "gradually_rising"
  | "sharply_breaking_out"
  | "declining"
  | "sharply_crashing"
  | "volatile"
  | "insufficient_data";

export type RegimeConfidence = "high" | "medium" | "low";

export interface RegimeDiagnostics {
  compsUsedForClassification: number;
  windowDays: number;
  slopePctPerMonth: number | null;
  r2: number | null;
  coefficientOfVariation: number | null;
  recentMeanLast14d: number | null;
  olderMean14to90d: number | null;
  pctChangeRecentVsOlder: number | null;
  classificationReason: string;
}

export interface RegimeResult {
  regime: Regime;
  confidence: RegimeConfidence;
  diagnostics: RegimeDiagnostics;
}

/**
 * Minimal comp shape accepted by the classifier. Accepts either `date` (the
 * internal `computeEstimate` comp shape) or `soldDate` (the raw Card Hedge
 * comp shape) — either field, whichever is populated, supplies the timestamp.
 */
export interface RegimeInputComp {
  price: number;
  date?: string | number | Date | null;
  soldDate?: string | number | Date | null;
}

const WINDOW_DAYS = 90;
const RECENT_WINDOW_DAYS = 14;
const MIN_COMPS_FOR_CLASSIFICATION = 5;
const SLOPE_FLAT_THRESHOLD_PCT_PER_MONTH = 2;
const BREAKOUT_PCT_THRESHOLD = 15;
const VOLATILITY_COV_THRESHOLD = 0.3;
const R2_NOISE_THRESHOLD = 0.2;
const DAY_MS = 86_400_000;

// Test seam — lets unit tests pin "now" without mocking the global Date.
const NOW_OVERRIDE: { value: number | null } = { value: null };
export function _setRegimeNowOverride(tsMs: number | null): void {
  NOW_OVERRIDE.value = tsMs;
}
function nowMs(): number {
  return NOW_OVERRIDE.value ?? Date.now();
}

function parseTimestamp(c: RegimeInputComp): number | null {
  const raw = c.date ?? c.soldDate ?? null;
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function classifyRegime(input: ReadonlyArray<RegimeInputComp>): RegimeResult {
  const now = nowMs();
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const recentCutoff = now - RECENT_WINDOW_DAYS * DAY_MS;

  const dated = (input ?? [])
    .map((c) => ({ price: Number(c.price), ts: parseTimestamp(c) }))
    .filter(
      (p): p is { price: number; ts: number } =>
        Number.isFinite(p.price) && p.price > 0 && p.ts !== null && p.ts >= cutoff && p.ts <= now,
    )
    .sort((a, b) => a.ts - b.ts);

  if (dated.length < MIN_COMPS_FOR_CLASSIFICATION) {
    return {
      regime: "insufficient_data",
      confidence: "low",
      diagnostics: {
        compsUsedForClassification: dated.length,
        windowDays: WINDOW_DAYS,
        slopePctPerMonth: null,
        r2: null,
        coefficientOfVariation: null,
        recentMeanLast14d: null,
        olderMean14to90d: null,
        pctChangeRecentVsOlder: null,
        classificationReason: `Only ${dated.length} usable comp(s) in last ${WINDOW_DAYS} days (need >= ${MIN_COMPS_FOR_CLASSIFICATION}).`,
      },
    };
  }

  const recent = dated.filter((p) => p.ts >= recentCutoff);
  const older = dated.filter((p) => p.ts < recentCutoff);
  const meanOf = (arr: { price: number }[]): number | null =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b.price, 0) / arr.length;
  const recentMean = meanOf(recent);
  const olderMean = meanOf(older);
  const pctChange =
    recentMean !== null && olderMean !== null && olderMean > 0
      ? ((recentMean - olderMean) / olderMean) * 100
      : null;

  // Step 3: breakout / crash short-circuit
  if (recent.length >= 3 && pctChange !== null) {
    if (pctChange > BREAKOUT_PCT_THRESHOLD) {
      return finalize({
        regime: "sharply_breaking_out",
        dated,
        recentMean,
        olderMean,
        pctChange,
        slopePctPerMonth: null,
        r2: null,
        cov: null,
        reason: `Last ${RECENT_WINDOW_DAYS}d mean is ${pctChange.toFixed(1)}% above 14-${WINDOW_DAYS}d mean across ${recent.length} recent sales.`,
      });
    }
    if (pctChange < -BREAKOUT_PCT_THRESHOLD) {
      return finalize({
        regime: "sharply_crashing",
        dated,
        recentMean,
        olderMean,
        pctChange,
        slopePctPerMonth: null,
        r2: null,
        cov: null,
        reason: `Last ${RECENT_WINDOW_DAYS}d mean is ${pctChange.toFixed(1)}% below 14-${WINDOW_DAYS}d mean across ${recent.length} recent sales.`,
      });
    }
  }

  // Step 4: linear regression on the 90-day window
  const t0 = dated[0].ts;
  const n = dated.length;
  const xs = dated.map((p) => (p.ts - t0) / DAY_MS);
  const ys = dated.map((p) => p.price);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let ssxy = 0;
  let ssxx = 0;
  let ssyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    ssxy += dx * dy;
    ssxx += dx * dx;
    ssyy += dy * dy;
  }
  const slopePerDay = ssxx > 0 ? ssxy / ssxx : 0;
  const slopePctPerMonth = meanY > 0 ? (slopePerDay * 30) / meanY * 100 : 0;
  const r2 = ssxx > 0 && ssyy > 0 ? Math.max(0, Math.min(1, (ssxy * ssxy) / (ssxx * ssyy))) : 0;
  const variance = n > 1 ? ssyy / (n - 1) : 0;
  const stdDev = Math.sqrt(Math.max(variance, 0));
  const cov = meanY > 0 ? stdDev / meanY : 0;

  let regime: Regime;
  let reason: string;
  if (r2 < R2_NOISE_THRESHOLD) {
    if (cov > VOLATILITY_COV_THRESHOLD) {
      regime = "volatile";
      reason = `Regression noisy (R^2 ${r2.toFixed(2)} < ${R2_NOISE_THRESHOLD}) and CoV ${cov.toFixed(2)} > ${VOLATILITY_COV_THRESHOLD}.`;
    } else {
      regime = "stable";
      reason = `Regression noisy (R^2 ${r2.toFixed(2)} < ${R2_NOISE_THRESHOLD}) but CoV ${cov.toFixed(2)} within tight band.`;
    }
  } else if (slopePctPerMonth > SLOPE_FLAT_THRESHOLD_PCT_PER_MONTH) {
    regime = "gradually_rising";
    reason = `Slope ${slopePctPerMonth.toFixed(1)}%/mo (R^2 ${r2.toFixed(2)}).`;
  } else if (slopePctPerMonth < -SLOPE_FLAT_THRESHOLD_PCT_PER_MONTH) {
    regime = "declining";
    reason = `Slope ${slopePctPerMonth.toFixed(1)}%/mo (R^2 ${r2.toFixed(2)}).`;
  } else {
    regime = "stable";
    reason = `Slope ${slopePctPerMonth.toFixed(1)}%/mo within +/-${SLOPE_FLAT_THRESHOLD_PCT_PER_MONTH}% (R^2 ${r2.toFixed(2)}).`;
  }

  return finalize({
    regime,
    dated,
    recentMean,
    olderMean,
    pctChange,
    slopePctPerMonth,
    r2,
    cov,
    reason,
  });
}

interface FinalizeArgs {
  regime: Regime;
  dated: { price: number; ts: number }[];
  recentMean: number | null;
  olderMean: number | null;
  pctChange: number | null;
  slopePctPerMonth: number | null;
  r2: number | null;
  cov: number | null;
  reason: string;
}

function finalize(args: FinalizeArgs): RegimeResult {
  const n = args.dated.length;
  let confidence: RegimeConfidence;
  if (n >= 15) confidence = "high";
  else if (n >= 10) confidence = "medium";
  else confidence = "low";

  // Boundary proximity: if slope is within ±25% of the flat-threshold edge,
  // demote confidence by one level (high → medium, medium → low).
  if (args.slopePctPerMonth !== null) {
    const boundary = SLOPE_FLAT_THRESHOLD_PCT_PER_MONTH;
    const distance = Math.abs(Math.abs(args.slopePctPerMonth) - boundary);
    if (distance <= boundary * 0.25) {
      if (confidence === "high") confidence = "medium";
      else if (confidence === "medium") confidence = "low";
    }
  }

  return {
    regime: args.regime,
    confidence,
    diagnostics: {
      compsUsedForClassification: n,
      windowDays: WINDOW_DAYS,
      slopePctPerMonth: args.slopePctPerMonth === null ? null : round(args.slopePctPerMonth, 3),
      r2: args.r2 === null ? null : round(args.r2, 3),
      coefficientOfVariation: args.cov === null ? null : round(args.cov, 3),
      recentMeanLast14d: args.recentMean === null ? null : round(args.recentMean, 2),
      olderMean14to90d: args.olderMean === null ? null : round(args.olderMean, 2),
      pctChangeRecentVsOlder: args.pctChange === null ? null : round(args.pctChange, 2),
      classificationReason: args.reason,
    },
  };
}
