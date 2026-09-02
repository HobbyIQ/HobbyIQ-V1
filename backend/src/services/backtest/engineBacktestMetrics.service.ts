// CF-ENGINE-BACKTEST (#1651, Drew 2026-09-02). The pure math behind the
// published accuracy number: "HobbyIQ's projected price landed within X% of
// the actual next sale, on N held-out sales."
//
// This module extends CF-BACKTEST-ACCURACY (2026-07-17) rather than forking
// it: `computeBacktestAccuracy` still owns the error distribution for a set of
// (predicted, actual) pairs, and everything here is about SLICING that set —
// by rung, sport, price band and pool freshness — so the headline can be read
// as "and here is where it comes from" instead of one number with no inside.
//
// WHY THE SLICES ARE THE POINT. A single median error over a mixed population
// is not a claim anyone can act on: it is dominated by whichever rung happened
// to be most common in the sample. The rung slice is what makes the report
// mean something — it separates "the exact pool priced this and we were close"
// from "no pool existed and we guessed from the family", which are different
// products with different error bars, and it is the axis the #1647 improvement
// claim is measured on.
//
// ONE DEFINITION OF ERROR, everywhere. Signed percentage error against the
// ACTUAL sale:
//
//     err = (predicted − actual) / actual
//
// Note the denominator. The older pair math divides by `predicted`, which was
// right for its question ("how far did reality land from what we said?") but
// wrong for a published accuracy figure: with `predicted` on the bottom, an
// engine can improve its own score by predicting a larger number, and "within
// 10%" stops meaning within 10% of the sale. Dividing by the ACTUAL makes the
// claim the one a reader assumes it is — the error as a share of what the card
// really sold for — and makes over- and under-shoots comparable. Both are
// reported (`medianSignedPctError` alongside the absolute) because a bias is a
// different defect from a spread: an engine that is 20% high on everything is
// wrong in a way you can correct, one that is randomly 20% off is not.
//
// MEDIANS HERE ARE NOT A PRICE. The golden rule — FMV is the projected next
// sale, never a median — is about how a CARD is priced. This module takes
// medians of ERRORS across many cards, which is the opposite operation: a
// robust summary of how wrong the projections were. Nothing here feeds a
// valuation.

/** One evaluation point: the engine's as-of projection vs the sale that
 *  actually came next. */
export interface EvaluationPoint {
  cardId: string;
  /** The instant the engine was asked to price as of (ISO). */
  asOf: string;
  /** The engine's projected next sale, computed from pre-cutoff data only. */
  predicted: number;
  /** The held-out sale: the first sale of this identity at or after `asOf`. */
  actual: number;
  actualSoldAt: string;
  /** Days between the cutoff and the held-out sale. */
  daysAhead: number;
  /** The rung that produced `predicted`, in the closed fmvRung vocabulary. */
  rung: string;
  sport: string | null;
  /** How many sales the rung priced from. */
  compsUsed: number;
  /** Age in days, at the cutoff, of the newest sale the engine could see.
   *  The freshness axis: the engine's honest disadvantage, made visible. */
  poolAgeDays: number | null;
  /** The engine's own confidence for the rung, for the calibration check. */
  confidence: number | null;
}

export interface ErrorDistribution {
  n: number;
  medianAbsPctError: number | null;
  meanAbsPctError: number | null;
  /** The bias: a signed median. Positive = the engine reads high. */
  medianSignedPctError: number | null;
  within10Pct: number | null;
  within25Pct: number | null;
  within50Pct: number | null;
  /** Share where predicted > actual. */
  overShootShare: number | null;
  p90AbsPctError: number | null;
}

export interface SliceResult extends ErrorDistribution {
  slice: string;
  key: string;
}

export interface EngineBacktestReport {
  generatedAt: string;
  totalPoints: number;
  /** Points dropped before scoring, and why. */
  excluded: Record<string, number>;
  overall: ErrorDistribution;
  byRung: SliceResult[];
  bySport: SliceResult[];
  byPriceBand: SliceResult[];
  byPoolFreshness: SliceResult[];
  byDaysAhead: SliceResult[];
  /** CF-PLAYER-TREND-SPECULATION (#1647): the improvement claim. */
  speculationVsFallback: SpeculationComparison | null;
}

/**
 * The #1647 claim, measured. The speculation rung was inserted at exactly one
 * gap in the ladder: a cold pool whose own trend is unmeasurable. Before it
 * existed, those cards fell through to the family / sibling rungs. So the
 * honest comparison is THIS RUNG'S slice against the FALLBACK slice it took
 * those cards from — not against the whole population, and not against the
 * exact-pool rungs, which never competed for these cards at all.
 *
 * The caveat is stated in the report rather than hidden: these are two
 * different populations of cards, not an A/B on one population. A card is in
 * the speculation slice BECAUSE it has a readable anchor, and in the fallback
 * slice partly because it does not. The comparison is still the right one to
 * publish — it is the before-and-after a user of a cold card actually
 * experiences — but it is a cohort comparison and the report says so.
 */
export interface SpeculationComparison {
  speculation: ErrorDistribution;
  familyFallback: ErrorDistribution;
  /** median|abs error| improvement in percentage POINTS (positive = better). */
  medianAbsPctErrorDelta: number | null;
  within25PctDelta: number | null;
  verdict: "improves" | "no-material-change" | "regresses" | "insufficient-sample";
  note: string;
}

/** Rungs that ARE the family/sibling fallback tier the speculation rung was
 *  inserted above — the population it took its cards from. Cross-grade and
 *  the graded-pool inverse are deliberately NOT here: those price from THIS
 *  card's own sales at another grade, so they were never competing for a card
 *  whose own pool went cold at every tier. */
const FAMILY_FALLBACK_RUNGS = new Set([
  "family-baseline",
  "sibling-estimate",
  "sibling-parallel",
  "cross-setkey",
  "printrun-discovery",
  "grade-curve-estimate",
]);

export const SPECULATION_RUNG = "player-index-projection";

/** Below this many points a slice is reported with its count but no verdict —
 *  the same discipline as the 2026-07-17 pair math, one order up because a
 *  slice is a claim about a subpopulation. */
export const MIN_POINTS_FOR_SLICE = 30;

const PRICE_BANDS: Array<{ key: string; min: number; max: number }> = [
  { key: "under-25", min: 0, max: 25 },
  { key: "25-100", min: 25, max: 100 },
  { key: "100-500", min: 100, max: 500 },
  { key: "500-2500", min: 500, max: 2500 },
  { key: "2500-plus", min: 2500, max: Number.POSITIVE_INFINITY },
];

const FRESHNESS_BANDS: Array<{ key: string; min: number; max: number }> = [
  { key: "0-7d", min: 0, max: 7 },
  { key: "7-30d", min: 7, max: 30 },
  { key: "30-45d", min: 30, max: 45 },
  // Past 45d is STALE_COMP_DAYS — where the speculation rung lives.
  { key: "45-90d", min: 45, max: 90 },
  { key: "90-180d", min: 90, max: 180 },
];

export function priceBandFor(actual: number): string {
  for (const b of PRICE_BANDS) if (actual >= b.min && actual < b.max) return b.key;
  return "unknown";
}

export function freshnessBandFor(poolAgeDays: number | null): string {
  if (poolAgeDays === null || !Number.isFinite(poolAgeDays)) return "no-pool";
  for (const b of FRESHNESS_BANDS) if (poolAgeDays >= b.min && poolAgeDays < b.max) return b.key;
  return "180d-plus";
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(nums: number[], q: number): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}

const round4 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10000) / 10000);

/** A point is scorable when both sides are real, positive numbers. */
export function isScorable(p: EvaluationPoint): boolean {
  return Number.isFinite(p.predicted) && p.predicted > 0
    && Number.isFinite(p.actual) && p.actual > 0;
}

export function computeDistribution(points: EvaluationPoint[]): ErrorDistribution {
  const clean = points.filter(isScorable);
  if (clean.length === 0) {
    return {
      n: 0, medianAbsPctError: null, meanAbsPctError: null,
      medianSignedPctError: null, within10Pct: null, within25Pct: null,
      within50Pct: null, overShootShare: null, p90AbsPctError: null,
    };
  }
  // Signed error against the ACTUAL sale — see the header on why the actual is
  // the denominator.
  const signed = clean.map((p) => (p.predicted - p.actual) / p.actual);
  const abs = signed.map((e) => Math.abs(e));
  const share = (pred: (e: number) => boolean): number =>
    abs.filter(pred).length / abs.length;

  return {
    n: clean.length,
    medianAbsPctError: round4(median(abs)),
    meanAbsPctError: round4(abs.reduce((s, e) => s + e, 0) / abs.length),
    medianSignedPctError: round4(median(signed)),
    within10Pct: round4(share((e) => e <= 0.10)),
    within25Pct: round4(share((e) => e <= 0.25)),
    within50Pct: round4(share((e) => e <= 0.50)),
    overShootShare: round4(signed.filter((e) => e > 0).length / signed.length),
    p90AbsPctError: round4(quantile(abs, 0.90)),
  };
}

function sliceBy(
  points: EvaluationPoint[],
  slice: string,
  keyOf: (p: EvaluationPoint) => string,
): SliceResult[] {
  const groups = new Map<string, EvaluationPoint[]>();
  for (const p of points) {
    const k = keyOf(p);
    const g = groups.get(k);
    if (g) g.push(p); else groups.set(k, [p]);
  }
  return [...groups.entries()]
    .map(([key, ps]) => ({ slice, key, ...computeDistribution(ps) }))
    .sort((a, b) => b.n - a.n);
}

function compareSpeculation(points: EvaluationPoint[]): SpeculationComparison | null {
  const spec = points.filter((p) => p.rung === SPECULATION_RUNG);
  const fam = points.filter((p) => FAMILY_FALLBACK_RUNGS.has(p.rung));
  if (spec.length === 0 && fam.length === 0) return null;

  const s = computeDistribution(spec);
  const f = computeDistribution(fam);

  const enough = s.n >= MIN_POINTS_FOR_SLICE && f.n >= MIN_POINTS_FOR_SLICE;
  const dAbs = s.medianAbsPctError !== null && f.medianAbsPctError !== null
    ? round4(f.medianAbsPctError - s.medianAbsPctError)   // positive = spec better
    : null;
  const d25 = s.within25Pct !== null && f.within25Pct !== null
    ? round4(s.within25Pct - f.within25Pct)               // positive = spec better
    : null;

  let verdict: SpeculationComparison["verdict"] = "insufficient-sample";
  if (enough && dAbs !== null) {
    // A 2-percentage-point band around zero is "no material change": below
    // that the difference is not distinguishable from which cards happened to
    // land in which cohort.
    if (dAbs > 0.02) verdict = "improves";
    else if (dAbs < -0.02) verdict = "regresses";
    else verdict = "no-material-change";
  }

  return {
    speculation: s,
    familyFallback: f,
    medianAbsPctErrorDelta: dAbs,
    within25PctDelta: d25,
    verdict,
    note: enough
      ? "Cohort comparison, not an A/B: a card reaches the speculation rung BECAUSE it still has a readable anchor, which is part of why the family cohort is harder. Read it as the before/after a cold-pool card experiences, not as a controlled trial."
      : `Below the ${MIN_POINTS_FOR_SLICE}-point floor on at least one side (speculation n=${s.n}, family n=${f.n}) — reported without a verdict.`,
  };
}

/** The whole report from a set of evaluation points. */
export function buildEngineBacktestReport(
  points: EvaluationPoint[],
  excluded: Record<string, number> = {},
): EngineBacktestReport {
  const scorable = points.filter(isScorable);
  return {
    generatedAt: new Date().toISOString(),
    totalPoints: scorable.length,
    excluded,
    overall: computeDistribution(scorable),
    byRung: sliceBy(scorable, "rung", (p) => p.rung),
    bySport: sliceBy(scorable, "sport", (p) => p.sport ?? "unknown"),
    byPriceBand: sliceBy(scorable, "priceBand", (p) => priceBandFor(p.actual)),
    byPoolFreshness: sliceBy(scorable, "poolFreshness", (p) => freshnessBandFor(p.poolAgeDays)),
    byDaysAhead: sliceBy(scorable, "daysAhead", (p) =>
      p.daysAhead <= 3 ? "0-3d" : p.daysAhead <= 7 ? "3-7d" : p.daysAhead <= 14 ? "7-14d" : "14-30d"),
    speculationVsFallback: compareSpeculation(scorable),
  };
}

export const _FAMILY_FALLBACK_RUNGS = FAMILY_FALLBACK_RUNGS;
export const _PRICE_BANDS = PRICE_BANDS;
export const _FRESHNESS_BANDS = FRESHNESS_BANDS;
