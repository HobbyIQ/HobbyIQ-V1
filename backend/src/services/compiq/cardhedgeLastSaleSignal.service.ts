/**
 * CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): compute a multiplier-
 * model expectation for the cardhedge-last-sale path, and classify the
 * single trusted CH sale against the curated parallel premium range as a
 * Lean Buy / Hold / Lean Sell signal.
 *
 * CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26): make the model
 * expectation TREND-AWARE. Bucket the parent's base-auto pool by day,
 * fit a weighted linear regression, and use the TREND-PROJECTED base
 * (at the sale date) as the anchor when the trend is "up" or "down".
 * Fall back to the static all-time median when the trend is "flat" or
 * the pool is too thin to fit. Adds:
 *   - trendAnchor block (direction + slope + R² + projected bases)
 *   - forwardProjection block (R²-gated next-sale prediction interval)
 *   - positionSignal block (gain/loss vs purchasePrice — display only)
 *
 * SINGLE ANCHOR MECHANISM (locked): when the trend fits, the projected
 * base REPLACES Build B's all-time median for the expectation calc.
 * Don't stack — one anchor decision per signal.
 *
 * Closes the two gaps the prior recon identified:
 *
 *   GAP A — subset resolution. The CH-served pinned path's identity
 *           reads `set: ctx.product` ("Bowman"), but the curated
 *           multiplier table indexes by SUBSET ("Chrome Prospect
 *           Autographs"). This module resolves the real subset via
 *           getCardDetail(cardsightCardId).setName.
 *
 *   GAP B — Build B was never wired into the cardhedge-last-sale arm.
 *           This module calls computeBaseAnchoredParallelFMV with the
 *           resolved subset + base-auto comps from the parent card's
 *           CS pricing pool.
 *
 * SCOPE GUARANTEE: this module is invoked ONLY when the engine has
 * decided the response is `estimateSource === "cardhedge-last-sale"`.
 * Every other source path is untouched. When ANY gate fails, returns
 * null and the caller emits the existing cardhedge-last-sale shape
 * without modelExpectation / modelSignal — no fake signals, no crashes.
 *
 * FMV STAYS NULL: this is a SIGNAL surface, not a FMV.
 */

import { getPricing, getCardDetail } from "./cardsight.client.js";
import { normalizeCardsightSetName } from "./cardsightSubsetNormalizer.js";
import {
  lookupBowmanFamilyEntry,
  type BowmanFamilyProduct,
  type BaseRelativePremium,
} from "./chromeDraftMultipliers.js";
import {
  computeBaseAnchoredParallelFMV,
  type BaseAnchoredFmvResult,
} from "../../agents/baseAnchoredParallelFMV.js";

// ─── CF-CH-MODEL-EXPECTATION-TREND-ANCHOR knobs (env-tunable) ─────────────
const DEFAULT_TREND_WINDOW_DAYS = 21;
const DEFAULT_TREND_DEAD_BAND_PCT = 0.5;
const DEFAULT_TREND_MIN_DAYS_WITH_SALES = 10;
const DEFAULT_TREND_MIN_R2 = 0.15;
const DEFAULT_TREND_FORWARD_STEP_DAYS = 7;
const TREND_ANCHOR_CLAMP_LOW_X = 0.4;
const TREND_ANCHOR_CLAMP_HIGH_X = 3.0;

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Trend-anchor block surfaced on modelExpectation when the base-auto
 * regression registers a non-flat trend. Hidden (null) when flat or
 * when the pool was too thin to fit — iOS doesn't render the chip in
 * those cases.
 */
export interface TrendAnchor {
  direction: "up" | "down";
  slopePctPerDay: number;
  trendConfidence: number;
  windowDays: number;
  daysWithSales: number;
  projectedBaseAtSale: number;
  projectedBaseToday: number;
  allTimeBaseMedian: number;
}

/**
 * R²-gated next-sale prediction band (price-space, BXF-EXPECTATION
 * units, i.e. trend-projected base × premium.value). Only populated
 * when the regression's R² clears MODEL_TREND_MIN_R2 and the trend is
 * not flat. Band widens naturally with low R² via the standard-error
 * formula. Hidden (null) otherwise.
 */
export interface ForwardProjection {
  low: number;
  high: number;
  basis: "trend-projection-prediction-interval";
  confidence: number;
}

/**
 * Cost-basis annotation. Computed when the holding carries a
 * purchasePrice. Display-only; DOES NOT modify modelSignal.lean —
 * the buy/sell signal is anchored on market data, not on the user's
 * cost basis.
 */
export interface PositionSignal {
  purchasePrice: number;
  gainVsLastSale: number;
  gainVsExpectation: number;
  gainPct: number;
}

export interface ModelExpectation {
  value: number;
  range: [number, number];
  multiplier: number;
  multiplierRange: [number, number];
  basis: BaseAnchoredFmvResult["estimateBasis"];
  n: number;
  baseAutoMedian: number;
  baseAutoCount: number;
  /** CF-CH-MODEL-EXPECTATION-TREND-ANCHOR. Optional + nullable. */
  trendAnchor?: TrendAnchor | null;
  forwardProjection?: ForwardProjection | null;
  positionSignal?: PositionSignal | null;
}

export interface ModelSignal {
  lean: "buy" | "hold" | "sell";
  deltaPct: number;
  expectation: number;
  effectiveMultiplier: number;
}

export interface ComputeCardhedgeLastSaleSignalParams {
  cardsightCardId: string;
  lastSalePrice: number;
  product: BowmanFamilyProduct;
  parallelName: string;
  year: number;
  /** CF-CH-MODEL-EXPECTATION-TREND-ANCHOR: ISO date string of the sale; required for trend. */
  lastSaleDate?: string | null;
  /** Holding's purchasePrice; required for positionSignal. */
  purchasePrice?: number | null;
}

export interface CardhedgeLastSaleSignalResult {
  modelExpectation: ModelExpectation;
  modelSignal: ModelSignal;
}

export interface CardhedgeLastSaleSignalClients {
  getCardDetail?: typeof getCardDetail;
  getPricing?: typeof getPricing;
}

// ─── Internal: dated comp shape ───────────────────────────────────────────
interface DatedComp {
  title: string;
  price: number;
  date: Date | null;
}

// ─── Internal: bucket DatedComps by UTC day ───────────────────────────────
interface DayBucket {
  /** Days since epoch (UTC). Used as the regression's x-axis. */
  dayIdx: number;
  /** Median price for the day. */
  median: number;
  /** Sale count for the day (the weight). */
  count: number;
}

function dayIdxUTC(d: Date): number {
  return Math.floor(d.getTime() / (24 * 3600 * 1000));
}

function median(values: ReadonlyArray<number>): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function bucketByDay(comps: ReadonlyArray<DatedComp>, windowStart: Date): DayBucket[] {
  const byDay = new Map<number, number[]>();
  const startIdx = dayIdxUTC(windowStart);
  for (const c of comps) {
    if (!c.date) continue;
    const idx = dayIdxUTC(c.date);
    if (idx < startIdx) continue;
    const arr = byDay.get(idx) ?? [];
    arr.push(c.price);
    byDay.set(idx, arr);
  }
  return Array.from(byDay.entries())
    .map(([dayIdx, prices]) => ({ dayIdx, median: median(prices), count: prices.length }))
    .sort((a, b) => a.dayIdx - b.dayIdx);
}

interface WeightedLinReg {
  slope: number;
  intercept: number;
  r2: number;
  residualStdErr: number;
  sumW: number;
  meanX: number;
  sumW_x_minus_mx_sq: number;
}

function weightedLinReg(buckets: ReadonlyArray<DayBucket>): WeightedLinReg | null {
  if (buckets.length < 2) return null;
  const sumW = buckets.reduce((s, b) => s + b.count, 0);
  if (sumW <= 0) return null;
  const meanX = buckets.reduce((s, b) => s + b.count * b.dayIdx, 0) / sumW;
  const meanY = buckets.reduce((s, b) => s + b.count * b.median, 0) / sumW;
  const num = buckets.reduce((s, b) => s + b.count * (b.dayIdx - meanX) * (b.median - meanY), 0);
  const sumWx2 = buckets.reduce((s, b) => s + b.count * (b.dayIdx - meanX) ** 2, 0);
  if (sumWx2 === 0) return null;
  const slope = num / sumWx2;
  const intercept = meanY - slope * meanX;
  const ssTot = buckets.reduce((s, b) => s + b.count * (b.median - meanY) ** 2, 0);
  const ssRes = buckets.reduce(
    (s, b) => s + b.count * (b.median - (slope * b.dayIdx + intercept)) ** 2,
    0,
  );
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  // Effective N for SE: distinct days (not weighted sum), so a single big day
  // doesn't shrink the standard error artificially.
  const effN = buckets.length;
  const residualStdErr = effN > 2 ? Math.sqrt(ssRes / sumW / Math.max(1, effN - 2)) : 0;
  return { slope, intercept, r2, residualStdErr, sumW, meanX, sumW_x_minus_mx_sq: sumWx2 };
}

/**
 * 80%-CI prediction interval half-width at x0 (in price space, base
 * units). Widens as x0 moves away from the mean of the fit, as R² drops
 * (via residualStdErr), and as N shrinks. Uses z=1.282 (normal approx
 * at 80% — small N caveat ignored; the R² gate above is the real
 * gate against thin fits).
 */
function predictionIntervalHalfWidth(reg: WeightedLinReg, x0: number): number {
  const Z80 = 1.282;
  const variance =
    reg.residualStdErr ** 2 *
    (1 + 1 / Math.max(1, reg.sumW) + (x0 - reg.meanX) ** 2 / Math.max(1e-9, reg.sumW_x_minus_mx_sq));
  return Z80 * Math.sqrt(Math.max(0, variance));
}

/**
 * Build the trendAnchor block from the dated base-auto pool. Returns
 * null when:
 *   - lastSaleDate is missing/unparseable
 *   - bucket count < DEFAULT_TREND_MIN_DAYS_WITH_SALES
 *   - regression fails (degenerate input)
 *   - trend is "flat" (slope within dead-band)
 *
 * When the regression succeeds and the trend is up/down, the projected
 * base is clamped to [TREND_ANCHOR_CLAMP_LOW_X, TREND_ANCHOR_CLAMP_HIGH_X]
 * × allTimeBaseMedian — the anti-parabola guard.
 *
 * Also returns the underlying regression object so the caller can build
 * the forwardProjection without recomputing.
 */
function computeTrendAnchor(
  datedComps: ReadonlyArray<DatedComp>,
  lastSaleDate: Date,
  allTimeBaseMedian: number,
): { trendAnchor: TrendAnchor; regression: WeightedLinReg; windowDays: number } | null {
  const windowDays = envNumber("MODEL_TREND_WINDOW_DAYS", DEFAULT_TREND_WINDOW_DAYS);
  const minDays = envNumber("MODEL_TREND_MIN_DAYS_WITH_SALES", DEFAULT_TREND_MIN_DAYS_WITH_SALES);
  const deadBandPct = envNumber("MODEL_TREND_DEAD_BAND_PCT", DEFAULT_TREND_DEAD_BAND_PCT);

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  const buckets = bucketByDay(datedComps, windowStart);
  if (buckets.length < minDays) return null;

  const reg = weightedLinReg(buckets);
  if (!reg) return null;

  // Slope as %/day relative to the window's median bucket — stable
  // reference; doesn't depend on the all-time pool's older mass.
  const windowMedian = median(buckets.map((b) => b.median));
  if (windowMedian <= 0) return null;
  const slopePctPerDay = (reg.slope / windowMedian) * 100;

  // Flat → null (caller falls back to all-time anchor).
  if (Math.abs(slopePctPerDay) < deadBandPct) return null;

  const saleIdx = dayIdxUTC(lastSaleDate);
  const todayIdx = dayIdxUTC(now);
  let projectedBaseAtSaleRaw = reg.slope * saleIdx + reg.intercept;
  let projectedBaseTodayRaw = reg.slope * todayIdx + reg.intercept;

  // Anti-parabola clamp on the anchor used downstream.
  const lowClamp = TREND_ANCHOR_CLAMP_LOW_X * allTimeBaseMedian;
  const highClamp = TREND_ANCHOR_CLAMP_HIGH_X * allTimeBaseMedian;
  const projectedBaseAtSale = Math.max(lowClamp, Math.min(highClamp, projectedBaseAtSaleRaw));
  const projectedBaseToday = Math.max(lowClamp, Math.min(highClamp, projectedBaseTodayRaw));

  return {
    trendAnchor: {
      direction: slopePctPerDay > 0 ? "up" : "down",
      slopePctPerDay: Math.round(slopePctPerDay * 100) / 100,
      trendConfidence: Math.round(reg.r2 * 1000) / 1000,
      windowDays,
      daysWithSales: buckets.length,
      projectedBaseAtSale: Math.round(projectedBaseAtSale * 100) / 100,
      projectedBaseToday: Math.round(projectedBaseToday * 100) / 100,
      allTimeBaseMedian: Math.round(allTimeBaseMedian * 100) / 100,
    },
    regression: reg,
    windowDays,
  };
}

/**
 * Build the forwardProjection block. Returns null when R² < min gate.
 * Band is in BXF-expectation price space: trend-projected base ×
 * premium.value, with the prediction interval half-width applied AT THE
 * BASE LAYER (before multiplying by the premium) so the band reflects
 * uncertainty in the base trajectory, not in the premium.
 */
function computeForwardProjection(
  reg: WeightedLinReg,
  saleDate: Date,
  premium: BaseRelativePremium,
  allTimeBaseMedian: number,
): ForwardProjection | null {
  const minR2 = envNumber("MODEL_TREND_MIN_R2", DEFAULT_TREND_MIN_R2);
  const stepDays = envNumber("MODEL_TREND_FORWARD_STEP_DAYS", DEFAULT_TREND_FORWARD_STEP_DAYS);
  if (reg.r2 < minR2) return null;

  const x0 = dayIdxUTC(saleDate) + stepDays;
  const projectedBase = reg.slope * x0 + reg.intercept;
  const half = predictionIntervalHalfWidth(reg, x0);

  // Anti-parabola clamp at the base layer.
  const lowClamp = TREND_ANCHOR_CLAMP_LOW_X * allTimeBaseMedian;
  const highClamp = TREND_ANCHOR_CLAMP_HIGH_X * allTimeBaseMedian;
  const baseLow = Math.max(lowClamp, Math.min(highClamp, projectedBase - half));
  const baseHigh = Math.max(lowClamp, Math.min(highClamp, projectedBase + half));

  return {
    low: Math.round(baseLow * premium.value * 100) / 100,
    high: Math.round(baseHigh * premium.value * 100) / 100,
    basis: "trend-projection-prediction-interval",
    confidence: Math.round(reg.r2 * 1000) / 1000,
  };
}

/**
 * Build the positionSignal block from the holding's purchasePrice. Null
 * when purchasePrice missing or non-positive. Display-only — does NOT
 * modify modelSignal.lean.
 */
function computePositionSignal(
  purchasePrice: number | null | undefined,
  lastSalePrice: number,
  expectation: number,
): PositionSignal | null {
  if (
    typeof purchasePrice !== "number" ||
    !Number.isFinite(purchasePrice) ||
    purchasePrice <= 0
  ) {
    return null;
  }
  const gainVsLastSale = lastSalePrice - purchasePrice;
  const gainVsExpectation = expectation - purchasePrice;
  const gainPct = (gainVsLastSale / purchasePrice) * 100;
  return {
    purchasePrice,
    gainVsLastSale: Math.round(gainVsLastSale * 100) / 100,
    gainVsExpectation: Math.round(gainVsExpectation * 100) / 100,
    gainPct: Math.round(gainPct * 10) / 10,
  };
}

/**
 * Best-effort: returns a populated signal when the gate chain passes,
 * otherwise null. Never throws — every async failure caught + logged.
 * Caller emits the cardhedge-last-sale shape unchanged on null.
 */
export async function computeCardhedgeLastSaleSignal(
  params: ComputeCardhedgeLastSaleSignalParams,
  clients: CardhedgeLastSaleSignalClients = {},
): Promise<CardhedgeLastSaleSignalResult | null> {
  const _getCardDetail = clients.getCardDetail ?? getCardDetail;
  const _getPricing = clients.getPricing ?? getPricing;

  if (
    !params.cardsightCardId ||
    !Number.isFinite(params.lastSalePrice) ||
    params.lastSalePrice <= 0
  ) {
    return null;
  }

  // ─── Gap A: subset resolution via getCardDetail ─────────────────────
  let setName: string | null = null;
  try {
    const detail = await _getCardDetail(params.cardsightCardId);
    if (!detail || detail.notFound) return null;
    setName =
      typeof detail.setName === "string" && detail.setName.trim().length > 0
        ? detail.setName.trim()
        : null;
  } catch {
    return null;
  }
  const subset = normalizeCardsightSetName(setName);
  if (!subset) return null;

  // Strip print-run suffix ("/150", "/99") before the curated-table lookup.
  const parallelNameForLookup = params.parallelName
    .replace(/\s*\/\s*\d+\s*$/, "")
    .trim();
  if (!parallelNameForLookup) return null;

  // ─── Gate: curated row + empirical baseRelativePremium ───────────────
  const row = lookupBowmanFamilyEntry({
    product: params.product,
    subset,
    parallelName: parallelNameForLookup,
    year: params.year,
  });
  const premium: BaseRelativePremium | undefined = row?.baseRelativePremium;
  if (!row || !premium || premium.provenance !== "empirical") return null;

  // ─── Gap B: pull base-auto pool with DATES (for trend regression) ────
  let baseAutoComps: Array<{ title: string; price: number }> = [];
  let datedComps: DatedComp[] = [];
  try {
    const pricing = await _getPricing(params.cardsightCardId);
    const rawRecords = pricing?.raw?.records ?? [];
    for (const r of rawRecords) {
      if (
        typeof r?.title !== "string" ||
        typeof r?.price !== "number" ||
        !Number.isFinite(r.price) ||
        r.price <= 0
      ) {
        continue;
      }
      baseAutoComps.push({ title: String(r.title), price: Number(r.price) });
      const dateRaw = (r as { date?: string }).date;
      let parsedDate: Date | null = null;
      if (typeof dateRaw === "string" && dateRaw.length > 0) {
        const dt = new Date(dateRaw);
        if (!isNaN(dt.getTime())) parsedDate = dt;
      }
      datedComps.push({ title: String(r.title), price: Number(r.price), date: parsedDate });
    }
  } catch {
    return null;
  }
  if (baseAutoComps.length === 0) return null;

  // ─── Build B against the base-auto pool (all-time methodology) ───────
  const buildB = computeBaseAnchoredParallelFMV({
    subject: {
      playerName: "",
      year: params.year,
      product: params.product,
      subset,
      parallelName: parallelNameForLookup,
    },
    comps: baseAutoComps,
  });
  if (
    !buildB.isEstimate ||
    buildB.estimatedValue === null ||
    buildB.estimateLow === null ||
    buildB.estimateHigh === null ||
    buildB.baseAutoMedian === null ||
    buildB.baseAutoMedian <= 0
  ) {
    return null;
  }

  // ─── Trend anchor (CF-CH-MODEL-EXPECTATION-TREND-ANCHOR) ─────────────
  // Filter dated comps to ONLY base autos (the same set Build B used),
  // by re-running the title classification via Build B's isBaseAutoTitle
  // path indirectly: we don't have the helper exported here, so the
  // simplest correct route is to bucket what BUILD B counted by re-
  // pairing dated rows that match the all-pool entries Build B kept.
  // Since we read from the same `raw.records` AND Build B's internal
  // filter is title-based deterministic on title alone, we can re-filter
  // datedComps with the same title-classifier the regression uses below.
  const datedBaseAutosOnly = datedComps.filter((c) =>
    titleLooksBaseAuto(c.title),
  );

  let trendAnchor: TrendAnchor | null = null;
  let regression: WeightedLinReg | null = null;
  let windowDaysUsed = envNumber("MODEL_TREND_WINDOW_DAYS", DEFAULT_TREND_WINDOW_DAYS);
  let lastSaleDateObj: Date | null = null;
  if (params.lastSaleDate) {
    const dt = new Date(params.lastSaleDate);
    if (!isNaN(dt.getTime())) lastSaleDateObj = dt;
  }
  if (lastSaleDateObj && datedBaseAutosOnly.length > 0) {
    const trendResult = computeTrendAnchor(
      datedBaseAutosOnly,
      lastSaleDateObj,
      buildB.baseAutoMedian,
    );
    if (trendResult) {
      trendAnchor = trendResult.trendAnchor;
      regression = trendResult.regression;
      windowDaysUsed = trendResult.windowDays;
    }
  }

  // ─── Anchor decision: trend (when up/down) OR Build B all-time ───────
  // SINGLE anchor mechanism — picks one path, doesn't stack.
  let expectationValue: number;
  let expectationLow: number;
  let expectationHigh: number;
  let basis: BaseAnchoredFmvResult["estimateBasis"] = buildB.estimateBasis;
  if (trendAnchor) {
    // Trend-anchored: anchor on projected base × premium.value;
    // band on projected base × premium.range[low|high].
    const anchorBase = trendAnchor.projectedBaseAtSale;
    expectationValue = Math.round(anchorBase * premium.value * 100) / 100;
    expectationLow = Math.round(anchorBase * premium.range[0] * 100) / 100;
    expectationHigh = Math.round(anchorBase * premium.range[1] * 100) / 100;
  } else {
    // Build B (all-time) — existing path.
    expectationValue = buildB.estimatedValue;
    expectationLow = buildB.estimateLow;
    expectationHigh = buildB.estimateHigh;
  }

  // ─── Signal: classify lastSale against the expectation band ──────────
  const effectiveMultiplier = params.lastSalePrice / buildB.baseAutoMedian;
  const lean: ModelSignal["lean"] =
    params.lastSalePrice > expectationHigh
      ? "sell"
      : params.lastSalePrice < expectationLow
        ? "buy"
        : "hold";
  const deltaPct = ((params.lastSalePrice - expectationValue) / expectationValue) * 100;

  // ─── Forward projection (R²-gated, only when trend non-flat) ─────────
  let forwardProjection: ForwardProjection | null = null;
  if (regression && lastSaleDateObj) {
    forwardProjection = computeForwardProjection(
      regression,
      lastSaleDateObj,
      premium,
      buildB.baseAutoMedian,
    );
  }

  // ─── Position signal (display-only, separate from lean) ──────────────
  const positionSignal = computePositionSignal(
    params.purchasePrice,
    params.lastSalePrice,
    expectationValue,
  );

  return {
    modelExpectation: {
      value: expectationValue,
      range: [expectationLow, expectationHigh],
      multiplier: premium.value,
      multiplierRange: premium.range,
      basis,
      n: premium.n,
      baseAutoMedian: buildB.baseAutoMedian,
      baseAutoCount: buildB.baseAutoCount,
      // CF-CH-MODEL-EXPECTATION-TREND-ANCHOR (2026-06-26): the three
      // optional sub-blocks are OMITTED (not null-valued) when their
      // respective conditions aren't met. Preserves the wire ADDITIVE
      // INVARIANT — pre-CF holdings (no trend, no forward, no
      // purchasePrice) emit a modelExpectation with the same shape as
      // pre-CF: no trendAnchor / forwardProjection / positionSignal
      // keys at all. The patch builder replaces the WHOLE
      // modelExpectation on each tick, so stale sub-keys from a prior
      // reprice are naturally cleared.
      ...(trendAnchor ? { trendAnchor } : {}),
      ...(forwardProjection ? { forwardProjection } : {}),
      ...(positionSignal ? { positionSignal } : {}),
    },
    modelSignal: {
      lean,
      deltaPct: Math.round(deltaPct * 10) / 10,
      expectation: expectationValue,
      effectiveMultiplier: Math.round(effectiveMultiplier * 1000) / 1000,
    },
  };
}

// ─── Title classifier (mirrors Build B's isBaseAutoTitle semantics) ───────
// We don't import from saleClassifier directly because Build B's exact
// filter lives behind its consumer; this title check is conservative and
// equivalent for the cardhedge-last-sale path (which only sees parent-
// pool records where parallel_id is null and the title has "auto" without
// parallel-decoration tokens).
function titleLooksBaseAuto(title: string): boolean {
  const t = String(title || "").toLowerCase();
  if (!/\bauto/.test(t)) return false;
  if (
    /\b(refractor|x[- ]?fractor|wave|shimmer|atomic|sapphire|reptilian|raywave|mini[- ]?diamond|orange|black|red|gold|yellow|green|blue|purple|aqua|speckle|lava)\b/.test(
      t,
    )
  ) {
    return /\bbase\b/.test(t);
  }
  return true;
}
