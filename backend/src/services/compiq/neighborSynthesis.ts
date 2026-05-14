// ---------------------------------------------------------------------------
// neighborSynthesis.ts
//
// Phase-1 Neighbor-Comp Synthesis Engine. When `computeEstimate()` would
// return a null FMV (variant-mismatch or no-recent-comps) but Card Hedge
// still returned related comps for the closest matching card_id, this
// module converts each related comp into a synthetic estimate for the
// target variant using the multiplier table in `neighborMultipliers.ts`.
//
// Output is conservative on purpose:
//   - confidence is hard-capped (default 30) so it never auto-reprices
//     inventory unless the operator explicitly lowers the gate.
//   - synthetic prices are 1.5-σ trimmed and require ≥ 3 surviving neighbors.
//   - per-neighbor multiplier is clipped to [0.05, 30] to stop a single
//     mis-classified parallel from blowing up the median.
// ---------------------------------------------------------------------------

import type { ParsedCardQuery } from "./cardQueryParser.js";
import { parseCardQuery } from "./cardQueryParser.js";
import {
  AUTO_PREMIUM_BY_TIER,
  gradeKey,
  lookupAutoPremium,
  lookupGradeMultiplier,
  lookupParallelMultiplier,
  parallelKey,
  printRunMultiplier,
  yearDeltaMultiplier,
} from "./neighborMultipliers.js";

export interface NeighborComp {
  price: number;
  title: string;
  soldDate?: string;
}

export interface SyntheticDetail {
  neighborTitle: string;
  neighborPrice: number;
  neighborParallel: string | null;
  neighborGrade: string | null;
  neighborIsAuto: boolean;
  neighborPrintRun: number | null;
  neighborYear: number | null;
  relativeMultiplier: number;
  syntheticPrice: number;
  stepsRelaxed: number;
  soldDate?: string;
}

export interface NeighborSynthesisResult {
  syntheticFmv: number | null;
  syntheticPrices: number[];
  neighborsUsed: number;
  neighborsConsidered: number;
  stepsRelaxedMax: number;
  detail: SyntheticDetail[];
  confidenceCap: number;
  riskFlags: string[];
  /** Top-3 same-parallel-tier median in target-equivalent dollars, when found. */
  anchor: {
    price: number;
    neighborsUsed: number;
    parallelTier: string;
    sources: Array<{ title: string; rawPrice: number; syntheticPrice: number; soldDate?: string }>;
  } | null;
  /**
   * Weekly trend slope across the whole neighbor pool over the trend window,
   * expressed as % per week (positive = rising). Null when the pool is too thin
   * to fit a slope. `direction` summarizes for the UI.
   */
  trend: {
    slopePctPerWeek: number;
    direction: "rising" | "falling" | "flat";
    weeklySamples: number;
    windowDays: number;
  } | null;
}

const CLAMP_MIN = 0.05;
const CLAMP_MAX = 30;
// Phase-1 trigger: 2 surviving synthetic comps is enough to publish an
// indicative FMV. We trim and clamp aggressively per-comp so a single
// outlier can't drive the median.
const MIN_SYNTHETICS_REQUIRED = 2;
// Hard ceiling for synthesized confidence. A 1-step relaxation lands at
// ~44, 2-step ~35, 3-step ~28. The portfolio reprice gate is currently
// 25 in production so closer neighbors actually drive InventoryIQ.
const HARD_CONFIDENCE_CAP = 55;

// ── Multiplier "product" for a parsed card variant ────────────────────────
// Returns null when any required dimension can't be resolved — caller
// rejects the neighbor in that case (we never invent a multiplier).
function variantMultiplierProduct(
  parsed: Pick<ParsedCardQuery, "parallel" | "isAuto" | "grade" | "gradingCompany" | "printRun" | "year">,
  opts: { playerTier?: string | null }
): { product: number; gradeM: number; parallelM: number; autoM: number; runM: number } | null {
  const gKey = gradeKey(parsed.gradingCompany, parsed.grade);
  const gradeM = lookupGradeMultiplier(gKey);
  if (gradeM == null) return null;

  const pKey = parallelKey(parsed.parallel);
  const parallelM = lookupParallelMultiplier(pKey);
  if (parallelM == null) return null;

  const autoM = parsed.isAuto ? lookupAutoPremium(opts.playerTier ?? null) : 1.0;
  const runM = printRunMultiplier(parsed.printRun);

  return {
    product: gradeM * parallelM * autoM * runM,
    gradeM,
    parallelM,
    autoM,
    runM,
  };
}

// ── Distance score: how many dimensions had to be relaxed ─────────────────
function relaxationSteps(target: ParsedCardQuery, neighbor: ParsedCardQuery): number {
  let steps = 0;
  if (parallelKey(target.parallel) !== parallelKey(neighbor.parallel)) steps += 1;
  if (Boolean(target.isAuto) !== Boolean(neighbor.isAuto)) steps += 1;
  if (gradeKey(target.gradingCompany, target.grade) !== gradeKey(neighbor.gradingCompany, neighbor.grade)) steps += 1;
  if ((target.printRun ?? null) !== (neighbor.printRun ?? null)) steps += 1;
  if (target.year && neighbor.year && target.year !== neighbor.year) steps += 1;
  return steps;
}

// ── Synthesize a single neighbor sale into a target-variant estimate ─────
function synthesizeOne(
  comp: NeighborComp,
  target: ParsedCardQuery,
  targetProduct: number,
  opts: { playerTier?: string | null }
): SyntheticDetail | null {
  if (!comp.title || !Number.isFinite(comp.price) || comp.price <= 0) return null;
  const neighborParsed = parseCardQuery(comp.title);
  const neighborProduct = variantMultiplierProduct(neighborParsed, opts);
  if (!neighborProduct || neighborProduct.product <= 0) return null;

  // Year-delta adjustment is applied OUTSIDE the multiplier product so a
  // ±1-year set release doesn't combinatorially explode with parallel scaling.
  const yearAdj = yearDeltaMultiplier(neighborParsed.year, target.year);

  const rawMultiplier = (targetProduct / neighborProduct.product) * yearAdj;
  // Clip to keep one mis-classified parallel from producing a $40k synthetic
  // from a $20 base-card sale.
  const relativeMultiplier = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, rawMultiplier));

  const synthetic = comp.price * relativeMultiplier;
  const steps = relaxationSteps(target, neighborParsed);

  return {
    neighborTitle: comp.title,
    neighborPrice: comp.price,
    neighborParallel: neighborParsed.parallel,
    neighborGrade: gradeKey(neighborParsed.gradingCompany, neighborParsed.grade),
    neighborIsAuto: neighborParsed.isAuto,
    neighborPrintRun: neighborParsed.printRun,
    neighborYear: neighborParsed.year,
    relativeMultiplier,
    syntheticPrice: synthetic,
    stepsRelaxed: steps,
    soldDate: comp.soldDate,
  };
}

// ── Median + 1.5σ trim ────────────────────────────────────────────────────
function trimmedMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  if (values.length < 4) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdev = Math.sqrt(variance);
  const lo = mean - 1.5 * stdev;
  const hi = mean + 1.5 * stdev;
  const kept = values.filter((v) => v >= lo && v <= hi);
  const pool = kept.length >= 3 ? kept : values;
  const sorted = [...pool].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Public entry point ────────────────────────────────────────────────────
export function synthesizeFromNeighbors(
  target: ParsedCardQuery,
  neighborComps: NeighborComp[],
  opts: { playerTier?: string | null; maxStepsAllowed?: number; trendWindowDays?: number } = {}
): NeighborSynthesisResult {
  const maxSteps = opts.maxStepsAllowed ?? 3;
  const trendWindowDays = opts.trendWindowDays ?? 60;
  const empty: NeighborSynthesisResult = {
    syntheticFmv: null,
    syntheticPrices: [],
    neighborsUsed: 0,
    neighborsConsidered: neighborComps.length,
    stepsRelaxedMax: 0,
    detail: [],
    confidenceCap: 0,
    riskFlags: [],
    anchor: null,
    trend: null,
  };

  const targetProduct = variantMultiplierProduct(target, opts);
  if (!targetProduct) {
    // We can't even classify the target's own variant -> can't synthesize.
    return { ...empty, riskFlags: ["target_variant_unclassifiable"] };
  }

  const synths: SyntheticDetail[] = [];
  for (const comp of neighborComps) {
    const s = synthesizeOne(comp, target, targetProduct.product, opts);
    if (!s) continue;
    if (s.stepsRelaxed > maxSteps) continue;
    synths.push(s);
  }

  if (synths.length < MIN_SYNTHETICS_REQUIRED) {
    return {
      ...empty,
      neighborsUsed: synths.length,
      detail: synths,
      riskFlags: ["insufficient_neighbors"],
    };
  }

  const prices = synths.map((s) => s.syntheticPrice);
  const trimmedFmv = trimmedMedian(prices);
  const stepsMax = synths.reduce((m, s) => Math.max(m, s.stepsRelaxed), 0);

  // ── Anchor: top-3 freshest neighbors in same parallel tier ─────────────
  // The anchor is the median synthetic price of up to 3 most-recent neighbors
  // whose parsed parallel matches the target's parallel TIER (substring match
  // on the color family). When found, the anchor takes precedence over the
  // pool median because those neighbors are the closest market signal.
  const targetTier = parallelTierKey(parsedParallelKey(target));
  let anchor: NeighborSynthesisResult["anchor"] = null;
  if (targetTier) {
    const sameTier = synths.filter((s) => {
      const nk = parallelTierKey(parsedParallelKey({ parallel: s.neighborParallel } as ParsedCardQuery));
      return nk && nk === targetTier;
    });
    if (sameTier.length > 0) {
      const ranked = [...sameTier].sort((a, b) => {
        const ta = Date.parse(a.soldDate || "") || 0;
        const tb = Date.parse(b.soldDate || "") || 0;
        return tb - ta;
      });
      const top = ranked.slice(0, 3);
      const sortedSynth = top.map((t) => t.syntheticPrice).sort((a, b) => a - b);
      const mid = Math.floor(sortedSynth.length / 2);
      const anchorPrice =
        sortedSynth.length % 2 === 0
          ? (sortedSynth[mid - 1] + sortedSynth[mid]) / 2
          : sortedSynth[mid];
      anchor = {
        price: anchorPrice,
        neighborsUsed: top.length,
        parallelTier: targetTier,
        sources: top.map((t) => ({
          title: t.neighborTitle,
          rawPrice: t.neighborPrice,
          syntheticPrice: t.syntheticPrice,
          soldDate: t.soldDate,
        })),
      };
    }
  }

  // FMV preference: anchor → trimmed median. Anchor is tighter when present.
  const fmv = anchor ? anchor.price : trimmedFmv;

  // ── Trend: weekly slope across full neighbor pool (target-equivalent $) ─
  const trend = computeWeeklyTrend(synths, trendWindowDays);

  // Confidence cap decays with distance: HARD_CONFIDENCE_CAP * 0.8^steps,
  // floor at 15. Anchor + rising trend each give a small confidence bump.
  const decayed = Math.round(HARD_CONFIDENCE_CAP * Math.pow(0.8, stepsMax));
  let confidenceCap = Math.max(15, Math.min(HARD_CONFIDENCE_CAP, decayed));
  if (anchor && anchor.neighborsUsed >= 2) confidenceCap = Math.min(HARD_CONFIDENCE_CAP, confidenceCap + 5);
  if (trend && trend.direction === "rising" && trend.weeklySamples >= 3) {
    confidenceCap = Math.min(HARD_CONFIDENCE_CAP, confidenceCap + 5);
  }

  const riskFlags = [
    "neighbor_synthesis",
    `${stepsMax}_steps_relaxed`,
    `${synths.length}_synthetic_comps`,
  ];
  if (anchor) riskFlags.push(`anchor_${anchor.neighborsUsed}_in_${anchor.parallelTier}`);
  if (trend) riskFlags.push(`trend_${trend.direction}_${trend.slopePctPerWeek.toFixed(1)}pct_per_week`);

  return {
    syntheticFmv: fmv,
    syntheticPrices: prices,
    neighborsUsed: synths.length,
    neighborsConsidered: neighborComps.length,
    stepsRelaxedMax: stepsMax,
    detail: synths,
    confidenceCap,
    riskFlags,
    anchor,
    trend,
  };
}

// ── Helpers: parallel-tier grouping + trend slope ─────────────────────────

function parsedParallelKey(p: { parallel: string | null }): string | null {
  if (!p.parallel) return null;
  return p.parallel.toLowerCase().trim();
}

/**
 * Reduce a parallel string to its "tier" key — the color family. Matches
 * neighbors like "Blue Wave Refractor" and "Blue Shimmer Refractor" to the
 * same "blue" tier so an anchor can be built from related parallels even
 * when the exact wording differs.
 */
function parallelTierKey(key: string | null): string | null {
  if (!key) return null;
  const colors = [
    "superfractor",
    "gold shimmer",
    "gold wave",
    "gold",
    "orange wave",
    "orange",
    "red wave",
    "red",
    "black wave",
    "black",
    "purple",
    "raywave_blue",
    "blue wave",
    "blue shimmer",
    "blue",
    "sky blue",
    "aqua",
    "green",
    "yellow",
    "pink",
    "refractor",
    "base",
  ];
  for (const c of colors) {
    if (key.includes(c)) return c;
  }
  return null;
}

function computeWeeklyTrend(
  synths: SyntheticDetail[],
  windowDays: number
): NeighborSynthesisResult["trend"] {
  const now = Date.now();
  const cutoff = now - windowDays * 24 * 3600 * 1000;
  const buckets = new Map<number, number[]>();
  for (const s of synths) {
    const ts = Date.parse(s.soldDate || "");
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    // Bucket by week index from today (0 = this week, 1 = last week, …).
    const wk = Math.floor((now - ts) / (7 * 24 * 3600 * 1000));
    if (!buckets.has(wk)) buckets.set(wk, []);
    buckets.get(wk)!.push(s.syntheticPrice);
  }
  if (buckets.size < 2) return null;
  // Convert each bucket to its median (resists outliers within a week).
  const points: Array<{ wk: number; median: number }> = [];
  for (const [wk, prices] of buckets.entries()) {
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    points.push({ wk, median: med });
  }
  // Older weeks have higher wk index. Fit a simple linear regression on
  // (weeks-ago, median price). A negative slope on (weeks-ago, price) means
  // price has been rising over time, so flip the sign for "% per week going
  // forward in time".
  const n = points.length;
  const xs = points.map((p) => p.wk);
  const ys = points.map((p) => p.median);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0 || yMean <= 0) return null;
  const slopePerWeekAgo = num / den; // $ change per week-ago
  const slopePctPerWeek = -(slopePerWeekAgo / yMean) * 100;
  let direction: "rising" | "falling" | "flat" = "flat";
  if (slopePctPerWeek > 2) direction = "rising";
  else if (slopePctPerWeek < -2) direction = "falling";
  return {
    slopePctPerWeek: Number(slopePctPerWeek.toFixed(2)),
    direction,
    weeklySamples: n,
    windowDays,
  };
}
