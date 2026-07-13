// CF-RESOLVER-FALLBACK-EVERYWHERE (2026-07-13): shared helper for the
// "CH catalog-miss → resolver rescue" pattern. Called at every price
// surface (autoPriceHolding, repriceHoldingsForUser, compiq/search,
// compiq/price, compiq/price-by-id) so the fallback logic lives in
// ONE place and evolves consistently.
//
// Contract:
//   - Only fires when CH truly had nothing (both fmv AND estimated null)
//   - Consults every registered vendor source in parallel
//   - Uses only NON-cardhedge winners (any cardhedge answer would have
//     already been consumed by the primary path)
//   - Returns null when no non-CH vendor has a confident answer

import {
  resolveCard,
  type CardQuery,
  type CardResolution,
  type ResolverComp,
  type ResolverGradedComp,
} from "./catalogResolver.service.js";

export interface FallbackResult {
  fairMarketValue: number;
  vendor: string;
  compCount: number;
  estimateBasis: string;
  /**
   * Underlying resolver record for callers that need the per-record
   * comp arrays (PR #407 trend / prediction on rescue paths). Never
   * surfaced on the wire — internal wiring only.
   */
  resolution?: CardResolution;
}

/**
 * Try the multi-source resolver as a rescue when the primary CH pricing
 * failed. Returns null unless a non-CH vendor has a positive FMV.
 *
 * Callers should merge the returned fields onto their response shape:
 *   - fairMarketValue → holding.fairMarketValue / response.marketValue
 *   - vendor          → holding.sourceVendor / response.sourceVendor
 *   - estimateBasis   → holding.estimateBasis / response.attribution
 * And stamp valuationStatus = "estimated", isEstimate = true.
 */
export async function tryResolverFallback(query: CardQuery): Promise<FallbackResult | null> {
  try {
    const resolution = await resolveCard(query);
    const w = resolution.winner;
    if (
      w &&
      w.vendor !== "cardhedge" &&
      typeof w.fairMarketValue === "number" &&
      w.fairMarketValue > 0
    ) {
      return {
        fairMarketValue: w.fairMarketValue,
        vendor: w.vendor,
        compCount: w.compCount,
        estimateBasis: `${w.compCount} comp(s) via ${w.vendor}`,
        resolution: w,
      };
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "resolver_fallback_error",
      source: "resolverFallbackHelper",
      error: (err as Error)?.message ?? String(err),
    }));
  }
  return null;
}

/**
 * Convenience: given a computed estimate result and a query, decide if the
 * fallback should fire. Encapsulates the "CH truly had nothing" predicate
 * so every caller uses the same rule.
 */
export function shouldTryFallback(estimate: {
  fairMarketValue?: number | null;
  estimatedValue?: number | null;
} | null | undefined): boolean {
  if (!estimate) return true;
  const hasFmv = typeof estimate.fairMarketValue === "number" && estimate.fairMarketValue > 0;
  const hasEstimated = typeof estimate.estimatedValue === "number" && estimate.estimatedValue > 0;
  return !hasFmv && !hasEstimated;
}

/**
 * CF-RESOLVER-FALLBACK-COMPIQ-ROUTES (2026-07-13): overlay helper for the
 * compiq/search + /price + /price-by-id routes. Called at the tail of each
 * route right before res.json. If the response's fairMarketValueLive AND
 * marketValue are both null (CH catalog gap), attempt the resolver fallback
 * and overlay the rescue vendor's FMV.
 *
 * DESIGN CONSTRAINT (Drew, 2026-07-13): iOS response shape stays identical
 * to the pre-fallback contract. The overlay only fills EXISTING fields that
 * CH would have populated on a successful pricing — no new keys iOS would
 * see. sourceVendor / vendor attribution is emitted to structured logs
 * only (for internal audit), never on the wire.
 *
 * Overlaid fields (all pre-existing on the response shape):
 *   fairMarketValueLive → resolver FMV
 *   marketValue         → resolver FMV
 *   marketTier.value    → resolver FMV (nested tier band)
 *   estimateBasis       → "N comp(s) via <vendor>" (CH also uses this key)
 *   approximate         → true (bool CH already flips)
 *
 * Pipeline fields (comps[], trendIQ, predictedPrice, etc.) are NOT
 * synthesized — they stay null. iOS renders the base price + skips the
 * trend/prediction blocks for null-signal responses just as it does for
 * a CH low-confidence result today.
 *
 * Idempotent + safe: returns the original response object mutated in-place.
 * Never throws.
 */
export async function overlayResolverRescue(
  response: any,
  query: CardQuery,
): Promise<any> {
  if (!response || typeof response !== "object") return response;

  // Skip when CH already produced a real FMV.
  const hasFmv =
    (typeof response.fairMarketValueLive === "number" && response.fairMarketValueLive > 0) ||
    (typeof response.marketValue === "number" && response.marketValue > 0);
  if (hasFmv) return response;

  const fallback = await tryResolverFallback(query);
  if (!fallback) return response;

  response.fairMarketValueLive = fallback.fairMarketValue;
  response.marketValue = fallback.fairMarketValue;
  response.estimateBasis = fallback.estimateBasis;
  response.approximate = true;
  if (response.marketTier && typeof response.marketTier === "object") {
    response.marketTier.value = fallback.fairMarketValue;
  }

  // CF-RESCUE-TREND-PREDICTION (Drew, 2026-07-13, PR #407): when the
  // resolution came with raw comps, run our own trajectory + prediction
  // math over the pooled records and overlay iOS' trendIQ +
  // predictedPrice fields. Wire keys unchanged — same shape iOS already
  // decodes from CH-covered SKUs; the rescue path just fills them from
  // Cardsight's records now instead of null.
  const raw = fallback.resolution?.rawComps ?? [];
  if (raw.length > 0) {
    const trend = computePooledTrend(raw);
    if (trend) {
      // Only overlay trend when CH didn't already produce one.
      if (!response.trendIQ || typeof response.trendIQ !== "object") {
        response.trendIQ = pooledTrendToTrendIQShape(trend);
      }
      const prediction = computePooledPrediction(fallback.fairMarketValue, trend);
      if (prediction) {
        if (response.predictedPrice == null) {
          response.predictedPrice = prediction.predictedPrice;
        }
        if (response.predictedPriceRange == null) {
          response.predictedPriceRange = prediction.predictedPriceRange;
        }
        if (response.predictedPriceAttribution == null) {
          response.predictedPriceAttribution = prediction.attribution;
        }
      }
    }
  }

  // Vendor attribution logged to KQL only — NOT on the wire (iOS shape lock).
  console.log(JSON.stringify({
    event: "catalog_resolver_route_rescue",
    source: "resolverFallbackHelper.overlayResolverRescue",
    vendor: fallback.vendor,
    fairMarketValue: fallback.fairMarketValue,
    compCount: fallback.compCount,
    rawCompsCount: raw.length,
    trendComputed: raw.length > 0 && computePooledTrend(raw) !== null,
    query: {
      playerName: query.playerName,
      cardYear: query.cardYear,
      parallel: query.parallel,
      cardNumber: query.cardNumber,
    },
  }));
  return response;
}

// ─── Pooled-comps trend + prediction (PR #407) ────────────────────────────

/**
 * A minimal trend read from pooled raw records: recent 14d vs older 15-45d
 * median. Mirrors the card-trajectory layer of TrendIQ so a rescued response
 * carries the same directional signal iOS' Card Detail trend badge decodes.
 *
 * NOT a full TrendIQ replacement — player-momentum and segment-trajectory
 * layers need cross-card data the resolver rescue doesn't have. This is the
 * one layer computable from a single card's pooled records.
 */
export interface PooledTrendRead {
  /** Signed % change (recent vs older median), clamped ±50. */
  pctChange: number;
  /** Multiplier centered on 1.0: clamp(0.70, 1.50, 1 + pctChange/100). */
  multiplier: number;
  /** "up" / "flat" / "down" — ±3% deadband, matching TrendIQ. */
  direction: "up" | "flat" | "down";
  recentMedian: number;
  olderMedian: number;
  recentCount: number;
  olderCount: number;
}

const RECENT_WINDOW_DAYS = 14;
const OLDER_WINDOW_START_DAYS = 15;
const OLDER_WINDOW_END_DAYS = 45;
const TREND_DEADBAND_PCT = 3;

function ageDays(saleDate: string | null, now: number): number | null {
  if (!saleDate) return null;
  const t = Date.parse(saleDate);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86_400_000;
}

/**
 * Compute a card-trajectory-style trend from pooled raw comps. Returns null
 * when neither window has at least 2 records — trend is meaningless below
 * that threshold and the iOS badge should render "no data" (or fall through
 * to a lower-confidence source, downstream's choice).
 */
export function computePooledTrend(
  rawComps: ResolverComp[],
  nowMs: number = Date.now(),
): PooledTrendRead | null {
  if (rawComps.length === 0) return null;
  const recent: number[] = [];
  const older: number[] = [];
  for (const c of rawComps) {
    if (c.price <= 0) continue;
    const age = ageDays(c.saleDate, nowMs);
    if (age === null) continue;
    if (age < 0) continue;   // future-dated, drop
    if (age <= RECENT_WINDOW_DAYS) recent.push(c.price);
    else if (age >= OLDER_WINDOW_START_DAYS && age <= OLDER_WINDOW_END_DAYS) {
      older.push(c.price);
    }
  }
  if (recent.length < 2 || older.length < 2) return null;
  const rMed = median(recent)!;
  const oMed = median(older)!;
  if (oMed <= 0) return null;
  const rawPct = ((rMed - oMed) / oMed) * 100;
  const pctChange = Math.max(-50, Math.min(50, rawPct));
  const multiplier = Math.max(0.70, Math.min(1.50, 1 + pctChange / 100));
  const direction: "up" | "flat" | "down" =
    Math.abs(pctChange) < TREND_DEADBAND_PCT ? "flat" : pctChange > 0 ? "up" : "down";
  return {
    pctChange: Math.round(pctChange * 10) / 10,
    multiplier: Math.round(multiplier * 1000) / 1000,
    direction,
    recentMedian: Math.round(rMed * 100) / 100,
    olderMedian: Math.round(oMed * 100) / 100,
    recentCount: recent.length,
    olderCount: older.length,
  };
}

/**
 * Simple 30d-forward prediction: FMV × trend multiplier. Range is ±spread
 * where the spread widens on low-sample-count trends (uncertainty).
 * Returns null when trend is unavailable or FMV is non-positive.
 */
export interface PooledPrediction {
  predictedPrice: number;
  predictedPriceRange: { low: number; high: number };
  attribution: {
    method: "pooled-comp-trend";
    trendPct: number;
    windowRecentDays: number;
    windowOlderDays: number;
  };
}

export function computePooledPrediction(
  fmv: number,
  trend: PooledTrendRead | null,
): PooledPrediction | null {
  if (!Number.isFinite(fmv) || fmv <= 0) return null;
  if (!trend) return null;
  const predicted = fmv * trend.multiplier;
  const totalCount = trend.recentCount + trend.olderCount;
  const spreadPct =
    totalCount >= 20 ? 0.10 :
    totalCount >= 10 ? 0.15 :
    totalCount >= 5 ? 0.22 :
    0.30;
  const low = Math.round(predicted * (1 - spreadPct));
  const high = Math.round(predicted * (1 + spreadPct));
  return {
    predictedPrice: Math.round(predicted),
    predictedPriceRange: { low, high },
    attribution: {
      method: "pooled-comp-trend",
      trendPct: trend.pctChange,
      windowRecentDays: RECENT_WINDOW_DAYS,
      windowOlderDays: OLDER_WINDOW_END_DAYS - OLDER_WINDOW_START_DAYS + 1,
    },
  };
}

/**
 * Shape the pooled trend into iOS' TrendIQ-compatible wire object. Only the
 * card-trajectory layer is populated — player-momentum and segment-trajectory
 * stay null, coverage is "card_only" (an already-defined TrendIQ coverage
 * tier from trendIQ.types.ts).
 */
export function pooledTrendToTrendIQShape(trend: PooledTrendRead): any {
  return {
    composite: trend.multiplier,
    direction: trend.direction,
    impliedPct: Math.round(trend.pctChange * 10) / 10,
    lastUpdated: new Date().toISOString(),
    components: {
      playerMomentum: null,
      cardTrajectory: {
        multiplier: trend.multiplier,
        pctChange: trend.pctChange,
        recentMedian: trend.recentMedian,
        olderMedian: trend.olderMedian,
        recentCount: trend.recentCount,
        olderCount: trend.olderCount,
        windowRecentDays: RECENT_WINDOW_DAYS,
        windowOlderDays: OLDER_WINDOW_END_DAYS - OLDER_WINDOW_START_DAYS + 1,
      },
      segmentTrajectory: null,
    },
    weights: {
      playerMomentum: 0,
      cardTrajectory: 1,
      segmentTrajectory: 0,
    },
    coverage: "card_only",
  };
}

// ─── /card-panel graded rescue (PR #406) ───────────────────────────────────

/**
 * A rescued grade-curve entry, matching the shape iOS' Card Detail grade
 * rail expects. Keys mirror `ObservedGradeEntry` (observedGradeCurve.service),
 * with trend/prediction fields left null — PR #407 will fill those from the
 * same pooled records.
 */
export interface RescuedGradeEntry {
  grade: string;
  grader: string;
  sampleCount: number;
  weightedMedianPrice: number | null;
  plainMedianPrice: number | null;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  newestSaleDate: string | null;
  oldestSaleDate: string | null;
  confidenceScore: number;
  value: number | null;
  valueSource: "observed" | "estimated" | "unavailable";
  estimatedMultiplier: number | null;
  estimatedFrom: null;
  trendAdjustedValue: null;
  trendAdjustmentPct: null;
  predictedPriceAt30d: null;
  predictedPricePct: null;
  predictedPriceRangeLow: null;
  predictedPriceRangeHigh: null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums: number[], p: number): number | null {
  if (nums.length < 4) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Sample-count and recency driven confidence, mirroring
 * observedGradeCurve.service's tiering. Kept simple so the rescue path
 * matches the primary path's shape without importing the full service.
 */
function confidenceFor(sampleCount: number, newestDate: string | null): number {
  const base =
    sampleCount >= 20 ? 1.0 :
    sampleCount >= 10 ? 0.85 :
    sampleCount >= 5 ? 0.70 :
    sampleCount >= 3 ? 0.50 :
    sampleCount >= 1 ? 0.20 : 0;
  if (!newestDate) return base;
  const ageMs = Date.now() - Date.parse(newestDate);
  const ageDays = ageMs / 86_400_000;
  return Number.isFinite(ageDays) && ageDays > 60 ? base * 0.7 : base;
}

/**
 * Turn a bucket of graded records (single grader + single grade) into a
 * RescuedGradeEntry. Records are prefiltered to positive prices at the
 * vendor boundary; we still guard here so a future vendor plugin that
 * skips the filter can't produce NaN medians.
 */
function bucketToEntry(
  grader: string,
  grade: string,
  records: ResolverGradedComp[],
): RescuedGradeEntry {
  const prices = records.map((r) => r.price).filter((p) => p > 0);
  const dates = records
    .map((r) => r.saleDate)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const newest = dates.length > 0 ? dates[dates.length - 1] : null;
  const oldest = dates.length > 0 ? dates[0] : null;
  const med = median(prices);
  const conf = confidenceFor(prices.length, newest);
  return {
    grade,
    grader,
    sampleCount: prices.length,
    weightedMedianPrice: med,
    plainMedianPrice: med,
    priceRangeLow: percentile(prices, 0.1),
    priceRangeHigh: percentile(prices, 0.9),
    newestSaleDate: newest,
    oldestSaleDate: oldest,
    confidenceScore: Math.round(conf * 100) / 100,
    value: med,
    valueSource: med != null ? "observed" : "unavailable",
    estimatedMultiplier: null,
    estimatedFrom: null,
    trendAdjustedValue: null,
    trendAdjustmentPct: null,
    predictedPriceAt30d: null,
    predictedPricePct: null,
    predictedPriceRangeLow: null,
    predictedPriceRangeHigh: null,
  };
}

/**
 * Group graded records by (grader, grade) and emit one RescuedGradeEntry
 * per bucket. Grade values render as strings so iOS can display "10" /
 * "9.5" identically to the CH-path.
 */
export function buildRescuedGradeEntries(
  gradedComps: ResolverGradedComp[],
): RescuedGradeEntry[] {
  const buckets = new Map<string, ResolverGradedComp[]>();
  for (const rec of gradedComps) {
    const key = `${rec.gradeCompany}::${rec.gradeValue}`;
    const list = buckets.get(key);
    if (list) list.push(rec);
    else buckets.set(key, [rec]);
  }
  const entries: RescuedGradeEntry[] = [];
  for (const [key, list] of buckets) {
    const [grader, gradeValueStr] = key.split("::");
    const gradeNum = Number(gradeValueStr);
    const gradeLabel = Number.isFinite(gradeNum)
      ? (gradeNum % 1 === 0 ? String(gradeNum) : gradeNum.toFixed(1))
      : gradeValueStr;
    entries.push(bucketToEntry(grader, gradeLabel, list));
  }
  return entries.sort((a, b) => {
    const graderOrder = ["PSA", "BGS", "SGC", "CGC"];
    const gi = graderOrder.indexOf(a.grader);
    const gj = graderOrder.indexOf(b.grader);
    if (gi !== gj) return (gi < 0 ? 99 : gi) - (gj < 0 ? 99 : gj);
    return Number(b.grade) - Number(a.grade);
  });
}

/**
 * Emit a Raw pseudo-entry from ungraded records — iOS' grade rail always
 * expects a "Raw" row at the head. Returns null when there are no raw
 * records to summarize.
 */
export function buildRescuedRawEntry(
  rawComps: ResolverComp[],
): RescuedGradeEntry | null {
  if (rawComps.length === 0) return null;
  const prices = rawComps.map((r) => r.price).filter((p) => p > 0);
  if (prices.length === 0) return null;
  const dates = rawComps
    .map((r) => r.saleDate)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const newest = dates.length > 0 ? dates[dates.length - 1] : null;
  const oldest = dates.length > 0 ? dates[0] : null;
  const med = median(prices);
  const conf = confidenceFor(prices.length, newest);
  return {
    grade: "Raw",
    grader: "RAW",
    sampleCount: prices.length,
    weightedMedianPrice: med,
    plainMedianPrice: med,
    priceRangeLow: percentile(prices, 0.1),
    priceRangeHigh: percentile(prices, 0.9),
    newestSaleDate: newest,
    oldestSaleDate: oldest,
    confidenceScore: Math.round(conf * 100) / 100,
    value: med,
    valueSource: med != null ? "observed" : "unavailable",
    estimatedMultiplier: null,
    estimatedFrom: null,
    trendAdjustedValue: null,
    trendAdjustmentPct: null,
    predictedPriceAt30d: null,
    predictedPricePct: null,
    predictedPriceRangeLow: null,
    predictedPriceRangeHigh: null,
  };
}

/**
 * CF-CARD-PANEL-GRADE-RESCUE (Drew, 2026-07-13, PR #406): overlay for the
 * /api/compiq/card-panel/:cardId route. When CH's grade curve is empty
 * (Cardsight-only SKU), pull the resolver's pooled raw + graded records
 * and synthesize grade-rail entries from them. Iimplements Drew's
 * "vendor-as-data-pipe, engine-as-brain" arc for the graded surface —
 * vendors provide sale records, we compute medians / confidence.
 *
 * Idempotent + safe: mutates `response.gradeCurve.entries` in place,
 * never throws, returns the response object. Skips when CH's grade
 * curve already has entries.
 */
export async function overlayGradeRescue(
  response: any,
  query: CardQuery,
): Promise<any> {
  if (!response || typeof response !== "object") return response;
  const gc = response.gradeCurve;
  if (!gc || typeof gc !== "object") return response;

  // Only rescue when the primary path yielded nothing.
  const existingEntries = Array.isArray(gc.entries) ? gc.entries : [];
  const hasSamples =
    (typeof gc.totalSampleCount === "number" && gc.totalSampleCount > 0) ||
    existingEntries.some(
      (e: any) => typeof e?.sampleCount === "number" && e.sampleCount > 0,
    );
  if (hasSamples) return response;

  let resolution: CardResolution | null = null;
  try {
    const r = await resolveCard(query);
    resolution = r.winner;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "grade_rescue_resolver_error",
      source: "resolverFallbackHelper.overlayGradeRescue",
      error: (err as Error)?.message ?? String(err),
    }));
    return response;
  }
  if (!resolution || resolution.vendor === "cardhedge") return response;

  const graded = resolution.gradedComps ?? [];
  const raw = resolution.rawComps ?? [];
  if (graded.length === 0 && raw.length === 0) return response;

  const rawEntry = buildRescuedRawEntry(raw);
  const gradedEntries = buildRescuedGradeEntries(graded);
  const merged: RescuedGradeEntry[] = [];
  if (rawEntry) merged.push(rawEntry);
  merged.push(...gradedEntries);

  gc.entries = merged;
  gc.totalSampleCount = merged.reduce((s, e) => s + e.sampleCount, 0);
  gc.computedAt = new Date().toISOString();

  console.log(JSON.stringify({
    event: "card_panel_grade_rescue",
    source: "resolverFallbackHelper.overlayGradeRescue",
    vendor: resolution.vendor,
    rawSamples: raw.length,
    gradedSamples: graded.length,
    entryCount: merged.length,
    query: {
      playerName: query.playerName,
      cardYear: query.cardYear,
      parallel: query.parallel,
    },
  }));
  return response;
}
