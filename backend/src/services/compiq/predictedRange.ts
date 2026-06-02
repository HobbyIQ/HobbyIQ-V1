// ---------------------------------------------------------------------------
// Predicted Range — Issue #25 Phase 2
//
// Pure function that emits a forward-looking { low, high } range for a card,
// driven by the Phase 1 regime classifier output. Mirrors the regimeClassifier
// pattern: no I/O, no engine dependencies, fully unit-testable, output is
// purely additive on the API response (no FMV / marketTier / buy/hold/sell
// math reads from this module).
//
// Authoritative design: issue #25 comment 4467241460 (Phase 2 design).
//
// High-level contract:
//   • Non-live source paths (legacy + current non-live values, e.g.
//     no-recent-comps,
//     unsupported_sport, variant-mismatch) → predictedRange = null.
//   • Regime "insufficient_data"            → predictedRange = null.
//   • Filter comps to same-grade pool, then apply the regime's window.
//     Fewer than 8 same-grade comps after filter → predictedRange = null.
//   • Regime math (see table below) operates on filtered same-grade pool.
//   • Sanity caps clamp output to [pool_p5 * 0.85, pool_p95 * 1.15]. When a
//     cap fires, adjustedConfidence drops one tier (high→medium, medium→low,
//     low stays low) and the diagnostic flag is recorded.
//
// Regime math (low → high):
//   stable               120d, p25–p75 of same-grade pool
//   gradually_rising     90d,  weighted p50–p80, × 1.05
//   declining            90d,  weighted p20–p50, × 0.95
//   sharply_breaking_out 7d primary  (14d fallback if <3 in 7d window),
//                        median7d → max7d × 1.10
//   sharply_crashing     7d primary  (14d fallback if <3 in 7d window),
//                        min7d × 0.95 → median14d (per spec table)
//   volatile             90d,  p15–p85
//   insufficient_data    null
//
// Implementation notes / open detail choices (per spec — defensible defaults
// documented here):
//   • Percentile uses LINEAR INTERPOLATION between adjacent ranks (Type 7),
//     consistent with NumPy default. Identical prices contribute equal weight
//     in input order; tie-breaking falls out of the interpolation when ranks
//     collide.
//   • Threshold "fewer than 8" means n < 8 returns null; n === 8 PASSES.
//   • Comps without a parseable date are EXCLUDED from the windowed pool.
//   • Weighted percentile (gradually_rising / declining):
//       bucket A = last 30 days, weight 2.0
//       bucket B = days 31..90,  weight 1.0
//     Sort by price ASC, accumulate weight, find the price where cumulative
//     weight first crosses the target fraction of total weight. Linear
//     interpolation between the straddling samples on the cumulative axis.
// ---------------------------------------------------------------------------

import type {
  Regime,
  RegimeConfidence,
  RegimeResult,
} from "./regimeClassifier.js";

export interface PredictedRangeInputComp {
  price: number;
  /** Raw comp title — used for the same-grade match. */
  title?: string | null;
  date?: string | number | Date | null;
  soldDate?: string | number | Date | null;
}

export interface PredictedRangeInput {
  comps: ReadonlyArray<PredictedRangeInputComp>;
  /**
   * Target grade in canonical "<COMPANY> <VALUE>" form (e.g. "PSA 10",
   * "BGS 9.5") or "Raw" / null / undefined for ungraded.
   */
  targetGrade: string | null | undefined;
  regimeResult: Pick<RegimeResult, "regime" | "confidence">;
  /** Estimate source string (e.g. "live"). */
  source: string | null | undefined;
}

export type PredictedRangeMath =
  | "stable_p25_p75"
  | "gradually_rising_weighted_p50_p80"
  | "declining_weighted_p20_p50"
  | "breaking_out_7day"
  | "breaking_out_14day_fallback"
  | "crashing_7day"
  | "crashing_14day_fallback"
  | "volatile_p15_p85"
  | "null_insufficient_data"
  | "null_non_live_source"
  | "null_sparse_same_grade"
  | "null_unknown_regime";

export type SanityCap = "lower" | "upper";

export interface PredictedRangeDiagnostics {
  windowAppliedDays: number | null;
  compsAfterFilter: number;
  mathApplied: PredictedRangeMath;
  sanityCapsApplied: SanityCap[];
  weightedPercentileBuckets:
    | { recent30dCount: number; days30to90Count: number }
    | null;
}

export interface PredictedRangeResult {
  predictedRange: { low: number | null; high: number | null };
  adjustedConfidence: RegimeConfidence | null;
  diagnostics: PredictedRangeDiagnostics;
}

const DAY_MS = 86_400_000;
const NON_LIVE_SOURCES: ReadonlySet<string> = new Set([
  "neighbor-synthesis",
  "no-recent-comps",
  "unsupported_sport",
  "variant-mismatch",
  // CF-LAUNCH-HARDENING (2026-06-02): new short-circuit sources from
  // computeEstimate's pre-modern + catalog-miss + upstream-timeout paths.
  // None carry a usable comp pool for range computation.
  "out-of-scope",
  "catalog-miss",
  "upstream-timeout",
]);
const MIN_COMPS_FOR_RANGE = 8;

// Test seam — mirror regimeClassifier's _setRegimeNowOverride.
const NOW_OVERRIDE: { value: number | null } = { value: null };
export function _setPredictedRangeNowOverride(tsMs: number | null): void {
  NOW_OVERRIDE.value = tsMs;
}
function nowMs(): number {
  return NOW_OVERRIDE.value ?? Date.now();
}

function parseTimestamp(c: PredictedRangeInputComp): number | null {
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Same-grade filter — uses substring match consistent with
// compiqEstimate.service.ts applyGradeFilter. For "Raw" / null target grade,
// includes comps whose title does NOT contain any grader marker.
// ---------------------------------------------------------------------------

const GRADER_MARKERS = ["psa", "bgs", "sgc", "cgc", "gma"];

function isRawGrade(target: string | null | undefined): boolean {
  if (target === null || target === undefined) return true;
  const t = String(target).trim().toLowerCase();
  return t === "" || t === "raw";
}

function compMatchesGrade(
  title: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const lowerTitle = String(title ?? "").toLowerCase();
  if (isRawGrade(target)) {
    return !GRADER_MARKERS.some((m) => lowerTitle.includes(m));
  }
  const lowerTarget = String(target).trim().toLowerCase();
  if (lowerTarget === "") return false;
  return lowerTitle.includes(lowerTarget);
}

// ---------------------------------------------------------------------------
// Percentile helpers
// ---------------------------------------------------------------------------

/** Linear-interpolation (Type 7) percentile. `pct` in [0, 100]. */
function percentile(sortedAsc: number[], pct: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]);
}

/**
 * Weighted percentile with linear interpolation. Items are sorted by price
 * ASC; we walk the cumulative-weight axis and interpolate between the two
 * samples that straddle the target cumulative weight.
 */
function weightedPercentile(
  items: ReadonlyArray<{ price: number; weight: number }>,
  pct: number,
): number {
  if (items.length === 0) return Number.NaN;
  if (items.length === 1) return items[0].price;
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const totalWeight = sorted.reduce((s, x) => s + x.weight, 0);
  if (totalWeight <= 0) return Number.NaN;
  const target = (Math.max(0, Math.min(100, pct)) / 100) * totalWeight;

  // Convention: place each item's "position" at the MIDPOINT of its weight
  // band on the cumulative axis (Type 7 analogue for weighted samples).
  let cum = 0;
  const positions: number[] = [];
  for (const item of sorted) {
    positions.push(cum + item.weight / 2);
    cum += item.weight;
  }

  if (target <= positions[0]) return sorted[0].price;
  if (target >= positions[positions.length - 1]) return sorted[sorted.length - 1].price;

  for (let i = 0; i < positions.length - 1; i++) {
    if (target >= positions[i] && target <= positions[i + 1]) {
      const span = positions[i + 1] - positions[i];
      const frac = span > 0 ? (target - positions[i]) / span : 0;
      return sorted[i].price + frac * (sorted[i + 1].price - sorted[i].price);
    }
  }
  return sorted[sorted.length - 1].price;
}

// ---------------------------------------------------------------------------
// Confidence demotion when sanity cap fires
// ---------------------------------------------------------------------------

function demote(c: RegimeConfidence): RegimeConfidence {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function nullResult(
  reason: PredictedRangeMath,
  compsAfterFilter: number,
  baseConfidence: RegimeConfidence | null,
): PredictedRangeResult {
  return {
    predictedRange: { low: null, high: null },
    adjustedConfidence: baseConfidence,
    diagnostics: {
      windowAppliedDays: null,
      compsAfterFilter,
      mathApplied: reason,
      sanityCapsApplied: [],
      weightedPercentileBuckets: null,
    },
  };
}

interface ComputedRange {
  low: number;
  high: number;
  math: PredictedRangeMath;
  buckets: { recent30dCount: number; days30to90Count: number } | null;
}

// ---------------------------------------------------------------------------
// Regime-specific math
// ---------------------------------------------------------------------------

interface DatedComp {
  price: number;
  ts: number;
}

function pricesAsc(dated: DatedComp[]): number[] {
  return dated.map((d) => d.price).sort((a, b) => a - b);
}

function stableMath(dated: DatedComp[]): ComputedRange {
  const asc = pricesAsc(dated);
  return {
    low: percentile(asc, 25),
    high: percentile(asc, 75),
    math: "stable_p25_p75",
    buckets: null,
  };
}

function volatileMath(dated: DatedComp[]): ComputedRange {
  const asc = pricesAsc(dated);
  return {
    low: percentile(asc, 15),
    high: percentile(asc, 85),
    math: "volatile_p15_p85",
    buckets: null,
  };
}

function weightedTrendMath(
  dated: DatedComp[],
  now: number,
  regime: "gradually_rising" | "declining",
): ComputedRange {
  const cutoff30 = now - 30 * DAY_MS;
  const weighted = dated.map((d) => ({
    price: d.price,
    weight: d.ts >= cutoff30 ? 2.0 : 1.0,
  }));
  const recent = weighted.filter((w) => w.weight === 2.0).length;
  const older = weighted.length - recent;

  if (regime === "gradually_rising") {
    const low = weightedPercentile(weighted, 50) * 1.05;
    const high = weightedPercentile(weighted, 80) * 1.05;
    return {
      low,
      high,
      math: "gradually_rising_weighted_p50_p80",
      buckets: { recent30dCount: recent, days30to90Count: older },
    };
  }
  // declining
  const low = weightedPercentile(weighted, 20) * 0.95;
  const high = weightedPercentile(weighted, 50) * 0.95;
  return {
    low,
    high,
    math: "declining_weighted_p20_p50",
    buckets: { recent30dCount: recent, days30to90Count: older },
  };
}

function sharpMath(
  dated14d: DatedComp[],
  now: number,
  regime: "sharply_breaking_out" | "sharply_crashing",
): ComputedRange {
  const cutoff7 = now - 7 * DAY_MS;
  const last7 = dated14d.filter((d) => d.ts >= cutoff7);

  if (regime === "sharply_breaking_out") {
    if (last7.length >= 3) {
      const asc7 = pricesAsc(last7);
      return {
        low: percentile(asc7, 50),
        high: Math.max(...asc7) * 1.1,
        math: "breaking_out_7day",
        buckets: null,
      };
    }
    const asc14 = pricesAsc(dated14d);
    return {
      low: percentile(asc14, 50),
      high: Math.max(...asc14) * 1.1,
      math: "breaking_out_14day_fallback",
      buckets: null,
    };
  }
  // sharply_crashing
  if (last7.length >= 3) {
    const asc7 = pricesAsc(last7);
    const asc14 = pricesAsc(dated14d);
    return {
      low: Math.min(...asc7) * 0.95,
      high: percentile(asc14, 50),
      math: "crashing_7day",
      buckets: null,
    };
  }
  const asc14 = pricesAsc(dated14d);
  return {
    low: Math.min(...asc14) * 0.95,
    high: percentile(asc14, 50),
    math: "crashing_14day_fallback",
    buckets: null,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

interface RegimePlan {
  windowDays: number;
}

function planFor(regime: Regime): RegimePlan | null {
  switch (regime) {
    case "stable":
      return { windowDays: 120 };
    case "gradually_rising":
    case "declining":
    case "volatile":
      return { windowDays: 90 };
    case "sharply_breaking_out":
    case "sharply_crashing":
      return { windowDays: 14 };
    case "insufficient_data":
      return null;
    default:
      return null;
  }
}

export function computePredictedRange(
  input: PredictedRangeInput,
): PredictedRangeResult {
  const baseConfidence = input.regimeResult?.confidence ?? null;
  const regime = input.regimeResult?.regime;
  const source = typeof input.source === "string" ? input.source : null;

  // (a) Non-live source override fires first.
  if (source && NON_LIVE_SOURCES.has(source)) {
    return nullResult("null_non_live_source", 0, baseConfidence);
  }

  // (b) Insufficient data short-circuit.
  if (regime === "insufficient_data" || !regime) {
    return nullResult("null_insufficient_data", 0, baseConfidence);
  }

  const plan = planFor(regime);
  if (!plan) {
    return nullResult("null_unknown_regime", 0, baseConfidence);
  }

  // (c) Same-grade filter.
  const sameGrade = (input.comps ?? []).filter((c) =>
    compMatchesGrade(c.title, input.targetGrade),
  );

  // (d) Window filter (parseable date inside trailing windowDays).
  const now = nowMs();
  const cutoff = now - plan.windowDays * DAY_MS;
  const dated: DatedComp[] = sameGrade
    .map((c) => ({ price: Number(c.price), ts: parseTimestamp(c) }))
    .filter(
      (p): p is DatedComp =>
        Number.isFinite(p.price) && p.price > 0 && p.ts !== null && p.ts >= cutoff && p.ts <= now,
    );

  // (e) Sparse-pool gate.
  if (dated.length < MIN_COMPS_FOR_RANGE) {
    const result = nullResult("null_sparse_same_grade", dated.length, baseConfidence);
    result.diagnostics.windowAppliedDays = plan.windowDays;
    return result;
  }

  // (f) Regime-specific math.
  let computed: ComputedRange;
  switch (regime) {
    case "stable":
      computed = stableMath(dated);
      break;
    case "volatile":
      computed = volatileMath(dated);
      break;
    case "gradually_rising":
    case "declining":
      computed = weightedTrendMath(dated, now, regime);
      break;
    case "sharply_breaking_out":
    case "sharply_crashing":
      computed = sharpMath(dated, now, regime);
      break;
    default:
      return nullResult("null_unknown_regime", dated.length, baseConfidence);
  }

  // (g) Sanity caps — clamp to [pool_p5 * 0.85, pool_p95 * 1.15] over the
  //     regime's own window.
  const asc = pricesAsc(dated);
  const lowerBound = percentile(asc, 5) * 0.85;
  const upperBound = percentile(asc, 95) * 1.15;
  const caps: SanityCap[] = [];

  let low = computed.low;
  let high = computed.high;
  if (Number.isFinite(lowerBound) && low < lowerBound) {
    low = lowerBound;
    caps.push("lower");
  }
  if (Number.isFinite(upperBound) && high > upperBound) {
    high = upperBound;
    caps.push("upper");
  }

  let adjustedConfidence: RegimeConfidence | null = baseConfidence;
  if (caps.length > 0 && adjustedConfidence) {
    adjustedConfidence = demote(adjustedConfidence);
  }

  // Final guard: ensure low ≤ high (clamping could in pathological pools
  // invert the range — collapse to a single point at the midpoint).
  if (low > high) {
    const mid = (low + high) / 2;
    low = mid;
    high = mid;
  }

  return {
    predictedRange: { low: round2(low), high: round2(high) },
    adjustedConfidence,
    diagnostics: {
      windowAppliedDays: plan.windowDays,
      compsAfterFilter: dated.length,
      mathApplied: computed.math,
      sanityCapsApplied: caps,
      weightedPercentileBuckets: computed.buckets,
    },
  };
}
