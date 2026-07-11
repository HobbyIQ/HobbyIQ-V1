// CF-NO-NULL-PRICING PR 4 (2026-07-11, Drew — era-baseline compute).
//
// Pure algorithm: takes a bucket's raw sales history and produces
// ONE EraBaselineDoc — recency-weighted currentValue, 7-day predicted
// value, trend direction. No I/O — the daily refresh job in a
// follow-up wraps this with the CH fetch + Cosmos write.
//
// The design principle: forward-looking. currentValue is what the
// era bucket is worth RIGHT NOW (heavy on last 7 days, tapering).
// predictedValue is a 7-day projection from a linear fit on recent
// data. Together they mirror the top-level estimate's fairMarketValue
// + predictedPrice shape.

import {
  CardClass,
  EraBaselineDoc,
  ERA_BASELINE_SCHEMA_VERSION,
  TrendDirection,
} from "./eraBaselines.types.js";
import { createHash } from "node:crypto";

export interface CompForBucket {
  /** Sale price in USD. */
  price: number;
  /** ISO date string OR epoch ms. */
  saleDate: string | number;
}

export interface ComputeEraBaselineInput {
  productKey: string;
  year: number;
  cardClass: CardClass;
  /** Every sale in the bucket over the last N days. */
  comps: CompForBucket[];
  /** ISO timestamp for the doc's computedAt field. */
  now: string;
}

// ─── Recency weight ──────────────────────────────────────────────────────
//
// Weight = exp(-ageDays / halfLife). Half-life 14 days means a sale
// from 14 days ago carries half the weight of today's sale. 30-day-old
// sales still contribute ~23%, 60-day-old sales ~5%.

const HALF_LIFE_DAYS = 14;

function ageDays(saleDate: string | number, nowMs: number): number {
  const d = typeof saleDate === "number" ? saleDate : Date.parse(saleDate);
  if (!Number.isFinite(d)) return Infinity;
  return Math.max(0, (nowMs - d) / (24 * 60 * 60 * 1000));
}

function recencyWeight(days: number): number {
  return Math.exp(-days / HALF_LIFE_DAYS);
}

// ─── Linear trend fit ────────────────────────────────────────────────────
//
// Ordinary least squares on (ageDays, price). Slope in $/day. Slope × 7
// projects the forward 7-day price movement from the current baseline.
//
// Returns { slope, intercept } — slope is $ per day (negative for
// downtrend). If the sample is too thin or degenerate (all same day),
// returns null and the caller uses currentValue as predictedValue
// (implicit flat trend).

interface TrendFit {
  slope: number;
  intercept: number;
}

function linearFit(points: Array<{ x: number; y: number }>): TrendFit | null {
  if (points.length < 3) return null;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }
  const n = points.length;
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null; // all same X
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// ─── Public compute API ──────────────────────────────────────────────────

/**
 * Produce one EraBaselineDoc from a bucket's comp history.
 *
 * Algorithm:
 *   1. Filter out invalid comps (bad prices / dates).
 *   2. currentValue = weighted average of prices with exp-decay recency.
 *   3. Fit linear OLS over the recent window (last 60 days) → slope.
 *      predictedValue = currentValue + slope × 7. If fit fails, use
 *      currentValue (flat trend).
 *   4. trendPct = (predictedValue - currentValue) / currentValue.
 *   5. trendDirection from trendPct with ±3% dead-band.
 *
 * Returns null when the bucket has fewer than 3 valid comps — not
 * enough signal to publish an era baseline.
 */
export function computeEraBaselineForBucket(
  input: ComputeEraBaselineInput,
): EraBaselineDoc | null {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("Invalid now timestamp");

  const validComps = input.comps
    .filter(
      (c) => typeof c.price === "number" && Number.isFinite(c.price) && c.price > 0,
    )
    .map((c) => ({ price: c.price, age: ageDays(c.saleDate, nowMs) }))
    .filter((c) => Number.isFinite(c.age));

  if (validComps.length < 3) return null;

  // 1. currentValue — recency-weighted mean.
  let sumWeighted = 0;
  let sumWeights = 0;
  for (const c of validComps) {
    const w = recencyWeight(c.age);
    sumWeighted += c.price * w;
    sumWeights += w;
  }
  const currentValue = sumWeights > 0 ? sumWeighted / sumWeights : 0;
  if (currentValue <= 0) return null;

  // 2. Linear fit for trend on last 60 days (age >= 0 means past;
  //    for fitting we invert so older = smaller x for a natural "over
  //    time, price went X" reading).
  const recentPoints = validComps
    .filter((c) => c.age <= 60)
    .map((c) => ({ x: -c.age, y: c.price }));

  const fit = linearFit(recentPoints);
  const slopePerDay = fit?.slope ?? 0;
  const projected = currentValue + slopePerDay * 7;
  const predictedValue = Math.max(projected, currentValue * 0.5); // clamp so a wild slope can't halve it

  // 3. Trend %.
  const trendPct = (predictedValue - currentValue) / currentValue;
  let trendDirection: TrendDirection = "flat";
  if (trendPct > 0.03) trendDirection = "up";
  else if (trendPct < -0.03) trendDirection = "down";

  const id = createHash("sha1")
    .update(`${input.productKey}|${input.year}|${input.cardClass}`)
    .digest("hex");

  const round2 = (v: number) => Math.round(v * 100) / 100;

  return {
    id,
    productKey: input.productKey,
    year: input.year,
    cardClass: input.cardClass,
    currentValue: round2(currentValue),
    predictedValue: round2(predictedValue),
    trendPct: round2(trendPct * 100) / 100, // round to 4 dp effectively
    trendDirection,
    sampleSize: validComps.length,
    currentRange: {
      low: round2(currentValue * 0.5),
      high: round2(currentValue * 2.0),
    },
    computedAt: input.now,
    schemaVersion: ERA_BASELINE_SCHEMA_VERSION,
  };
}
