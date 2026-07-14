// CF-CARDSIGHT-UUID-NATIVE (Drew, 2026-07-13, PR #412): direct-Cardsight
// UUID pricing route. Called from /api/compiq/price-by-id when the cardId
// is UUID-shaped and resolves in Cardsight's /v1 catalog.
//
// Design principles (matches the vendor-as-data-pipe arc, PRs #405-#409):
//   - Vendors provide atomic sale records; the engine computes the medians,
//     ranges, trend, prediction. Never read vendor-derived aggregates.
//   - Response shape is the SAME iOS wire iOS already decodes from the CH
//     path — same field names, same nullability, same picker contract.
//   - Graceful degradation: returns null on any failure so the caller can
//     fall through to CH's pipeline. Never throws.

import {
  getCardDetail,
  getPricing,
  isCardsightConfigured,
} from "./cardsightSlim.client.js";
import {
  computePooledTrend,
  computePooledPrediction,
  pooledTrendToTrendIQShape,
} from "./resolverFallbackHelper.js";

interface PriceByCardsightUuidInput {
  cardId: string;
  parallelId: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
}

// Match observedGradeCurve's confidence tiers so the wire shape is uniform
// across CH and Cardsight paths.
function confidenceFor(count: number, newestDate: string | null): number {
  const base =
    count >= 20 ? 1.0 :
    count >= 10 ? 0.85 :
    count >= 5 ? 0.70 :
    count >= 3 ? 0.50 :
    count >= 1 ? 0.20 : 0;
  if (!newestDate) return base;
  const ageMs = Date.now() - Date.parse(newestDate);
  const ageDays = ageMs / 86_400_000;
  return Number.isFinite(ageDays) && ageDays > 60 ? base * 0.7 : base;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// CF-SLOPE-VALUATION (Drew, 2026-07-13, PR #418): fit a linear
// regression to (dateMs, price) points and return the slope + intercept.
// The slope IS the direction of the market (positive = moving up,
// negative = down, near-zero = static). Valuing the card at t=now uses
// the regression line, so Market Value reflects "where the price
// currently sits per the observed sales trajectory" — not the median,
// not the last sale, not a windowed cutoff. Returns null when there's
// fewer than 2 points with distinct dates (no slope defined).
interface Regression {
  slope: number;      // dollars per millisecond
  // Intercept fitted on x = (tMs - firstT) — price at t=firstT.
  interceptAtFirstT: number;
  firstT: number;     // reference date (Unix ms of the earliest sale)
  n: number;
}

function fitLinearRegression(
  records: Array<{ tMs: number; price: number }>,
): Regression | null {
  if (records.length < 2) return null;
  const firstT = records[0].tMs;
  const distinctTimes = new Set(records.map((r) => r.tMs)).size;
  if (distinctTimes < 2) return null;

  const n = records.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const r of records) {
    // Normalize x to (dateMs - firstT) so the intercept fits at the
    // first sale's date, not the Unix epoch (avoids astronomical values).
    const x = r.tMs - firstT;
    const y = r.price;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  // Ordinary-least-squares intercept in the normalized x-space:
  //   intercept = ȳ - slope × x̄
  // This IS the fitted price at x=0, i.e. at t = firstT.
  const interceptAtFirstT = (sumY - slope * sumX) / n;
  return { slope, interceptAtFirstT, firstT, n };
}

function valueAt(reg: Regression, tMs: number): number {
  return reg.interceptAtFirstT + reg.slope * (tMs - reg.firstT);
}

/**
 * Compute Market Value + Predicted Price from a chronologically-ordered
 * pool of raw sales using linear regression.
 *
 * `marketValue` — regression fit at the MOST RECENT sale's date. Reflects
 *   what the market has been paying most recently along the observed
 *   trend line. Never above the highest observed sale for an up-trend
 *   (or below the lowest for a down-trend) because it's evaluated at a
 *   point WITHIN the observed data range.
 * `predictedPrice` — regression fit at now + 30 days. Extrapolates the
 *   slope forward. Can be higher than any observed sale if the trend
 *   is up, lower if down — that's intentional (it's a projection).
 * `direction` — up / down / static based on slope × 30d ("per-month
 *   trend"). Deadband: ±3% per 30d is "static".
 *
 * Returns null on any input that can't produce a slope (fewer than 2
 * dated records, all sales on the same day, etc.).
 */
interface SlopeValuation {
  marketValue: number;
  predictedPrice: number;
  predictedPriceRange: { low: number; high: number };
  direction: "up" | "down" | "static";
  slopePerMonthPct: number;
  n: number;
  regressionSlope: number;
}

const MS_PER_DAY = 86_400_000;
const STATIC_DEADBAND_PCT = 3;

function computeSlopeValuation(
  rawRecords: Array<{ date: string | null; price: number }>,
): SlopeValuation | null {
  const points = rawRecords
    .filter((r) => typeof r.date === "string" && r.date.length > 0 && r.price > 0)
    .map((r) => ({ tMs: Date.parse(r.date!), price: r.price }))
    .filter((p) => Number.isFinite(p.tMs));
  if (points.length < 2) return null;
  points.sort((a, b) => a.tMs - b.tMs);
  const firstT = points[0].tMs;

  const reg = fitLinearRegression(points);
  if (!reg) return null;

  const lastT = points[points.length - 1].tMs;
  const nowT = Date.now();
  const futureT = nowT + 30 * MS_PER_DAY;

  const marketAtLast = valueAt(reg, lastT);
  const predictedAt30d = valueAt(reg, futureT);

  // Slope reported as "% per month" so direction thresholds make sense.
  const monthlyDelta = reg.slope * 30 * MS_PER_DAY;
  const slopePerMonthPct = marketAtLast > 0
    ? (monthlyDelta / marketAtLast) * 100
    : 0;

  const direction: "up" | "down" | "static" =
    Math.abs(slopePerMonthPct) < STATIC_DEADBAND_PCT
      ? "static"
      : slopePerMonthPct > 0
        ? "up"
        : "down";

  // Range widens as sample count decreases (uncertainty on thin data).
  const spreadPct =
    reg.n >= 20 ? 0.10 :
    reg.n >= 10 ? 0.15 :
    reg.n >= 5 ? 0.22 :
    0.30;

  return {
    marketValue: Math.max(0, Math.round(marketAtLast * 100) / 100),
    predictedPrice: Math.max(0, Math.round(predictedAt30d * 100) / 100),
    predictedPriceRange: {
      low: Math.max(0, Math.round(predictedAt30d * (1 - spreadPct))),
      high: Math.round(predictedAt30d * (1 + spreadPct)),
    },
    direction,
    slopePerMonthPct: Math.round(slopePerMonthPct * 10) / 10,
    n: reg.n,
    regressionSlope: reg.slope,
  };
}

function percentile(nums: number[], p: number): number | null {
  if (nums.length < 4) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Route a UUID-shaped cardId through Cardsight's /v1 catalog + pricing.
 * Returns null when the cardId doesn't resolve or Cardsight isn't
 * configured — caller should fall back to the CH pipeline.
 *
 * The response is iOS' priced-card wire shape — computed by our engine
 * over Cardsight's raw records. Graded arrays feed the engine's
 * per-bucket median + confidence tier + trend / prediction pipeline.
 */
export async function priceByCardsightUuid(
  input: PriceByCardsightUuidInput,
): Promise<any | null> {
  if (!isCardsightConfigured()) return null;

  const detail = await getCardDetail(input.cardId).catch(() => null);
  if (!detail || detail.notFound) return null;

  // Filter pricing by parallelId when iOS pinned a specific variant.
  const pricing = await getPricing(input.cardId, {
    parallelId: input.parallelId ?? undefined,
  }).catch(() => null);
  if (!pricing || pricing.notFound) {
    // Card exists but no pricing yet — emit a valid response with empty
    // signals so iOS renders identity without breaking.
    return buildEmptyPricingResponse(input.cardId, detail);
  }

  // ── Engine math on Cardsight's raw records ────────────────────────
  const rawRecords = pricing.raw.records
    .filter((r) => typeof r.price === "number" && r.price > 0);
  const rawPrices = rawRecords.map((r) => r.price);
  const rawDates = rawRecords
    .map((r) => r.date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const rawFmv = median(rawPrices);
  const rawFmvLow = percentile(rawPrices, 0.1);
  const rawFmvHigh = percentile(rawPrices, 0.9);
  const newestRawDate = rawDates.length > 0 ? rawDates[rawDates.length - 1] : null;

  // Optional graded overlay: if the request pinned (gradeCompany, gradeValue),
  // prefer that bucket's records over raw. When the graded bucket has enough
  // time-spread the slope regression runs on ITS points; otherwise the
  // median stands in.
  let bucketFmv: number | null = null;
  let bucketCount = 0;
  let bucketNewest: string | null = null;
  let bucketRecordsForSlope: Array<{ date: string | null; price: number }> = [];
  if (input.gradeCompany && typeof input.gradeValue === "number") {
    const company = pricing.graded.find(
      (g) => g.company_name.toLowerCase().includes(input.gradeCompany!.toLowerCase()),
    );
    if (company) {
      const bucket = company.grades.find((g) => Number(g.grade_value) === input.gradeValue);
      if (bucket && bucket.records.length > 0) {
        const prices = bucket.records
          .map((r) => r.price)
          .filter((p) => typeof p === "number" && p > 0);
        bucketFmv = median(prices);
        bucketCount = prices.length;
        const dates = bucket.records
          .map((r) => r.date)
          .filter((d): d is string => typeof d === "string" && d.length > 0)
          .sort();
        bucketNewest = dates.length > 0 ? dates[dates.length - 1] : null;
        bucketRecordsForSlope = bucket.records
          .filter((r) => typeof r.price === "number" && r.price > 0)
          .map((r) => ({ date: r.date ?? null, price: r.price }));
      }
    }
  }

  const surfacedFmv = bucketFmv ?? rawFmv;
  const surfacedFmvLow = bucketFmv != null ? null : rawFmvLow;
  const surfacedFmvHigh = bucketFmv != null ? null : rawFmvHigh;
  const surfacedCount = bucketFmv != null ? bucketCount : rawPrices.length;
  const surfacedNewest = bucketFmv != null ? bucketNewest : newestRawDate;

  // Trend + prediction from the RAW pool (bucketed pool is too small for
  // a signal on most parallels). Falls back to null when the pool is thin.
  const compForms = rawRecords.map((r) => ({
    saleDate: r.date ?? null,
    price: r.price,
  }));
  const trend = computePooledTrend(compForms);
  const trendIQ = trend ? pooledTrendToTrendIQShape(trend) : null;

  const roundedFmv = surfacedFmv != null ? Math.round(surfacedFmv * 100) / 100 : null;

  // CF-SLOPE-VALUATION (Drew, 2026-07-13, PR #418): fit a linear
  // regression to (date, price) points and value the card at the most
  // recent sale's date. The slope IS the trend — positive means the
  // market is rising, negative means falling, near-zero means static.
  // Direction reported with a ±3%/month deadband.
  //
  // Walk-through with sales 175/176/204/208 over 30 days:
  //   slope        ≈ +$1.1/day (~+16% per month)
  //   marketValue  = value at last observed date ≈ $208
  //   predictedPrice = value at now + 30d ≈ $241
  //   direction    = up
  //
  // Falls back cleanly to full-pool median when the slope can't compute
  // (< 2 records, or all on the same day) — predictedPrice stays null.
  //
  // When the request pinned a graded bucket, the slope runs on that
  // bucket's records so a PSA 10-specific trend shows through.
  const slopeInput = bucketRecordsForSlope.length > 0
    ? bucketRecordsForSlope
    : rawRecords.map((r) => ({ date: r.date ?? null, price: r.price }));
  const slopeVal = computeSlopeValuation(slopeInput);
  const marketValue = slopeVal != null ? slopeVal.marketValue : roundedFmv;
  const prediction = slopeVal;

  // Build the wire response — same field shape iOS decodes from the CH
  // path. Fields not applicable to a Cardsight-only compute are null.
  return {
    success: true,
    cardId: input.cardId,
    // ── Pricing ────────────────────────────────────────────────────
    // Same trend-adjusted value flows into marketValue,
    // fairMarketValueLive, and marketTier.value so every "current worth"
    // surface iOS reads shows the SAME number.
    fairMarketValueLive: marketValue,
    marketValue,
    marketTier: {
      label: null,
      value: marketValue,
    },
    approximate: bucketFmv == null && rawPrices.length < 5,
    estimateBasis:
      surfacedCount > 0
        ? `${surfacedCount} comp(s) via cardsight`
        : null,
    predictedPrice: prediction ? prediction.predictedPrice : null,
    predictedPriceRange: prediction ? prediction.predictedPriceRange : null,
    predictedPriceAttribution: prediction
      ? {
          method: "linear-regression",
          direction: prediction.direction,
          slopePerMonthPct: prediction.slopePerMonthPct,
          n: prediction.n,
        }
      : null,
    trendIQ,
    // ── Identity ───────────────────────────────────────────────────
    cardIdentity: {
      card_id: input.cardId,
      player: detail.name,
      set: detail.setName,
      release: detail.releaseName,
      year: detail.year,
      number: detail.number,
      parallel: null,
      title: `${detail.year ?? ""} ${detail.releaseName ?? ""} ${detail.setName ?? ""} ${detail.name} ${detail.number}`.trim(),
    },
    // ── Signals ────────────────────────────────────────────────────
    compsUsed: surfacedCount,
    compsAvailable: rawPrices.length,
    daysSinceNewestComp: surfacedNewest
      ? Math.floor((Date.now() - Date.parse(surfacedNewest)) / 86_400_000)
      : null,
    lastSale: surfacedNewest
      ? {
          date: surfacedNewest,
          price:
            bucketFmv != null
              ? bucketFmv
              : rawPrices.length > 0
                ? rawPrices[rawPrices.length - 1]
                : null,
        }
      : null,
    confidence: confidenceFor(surfacedCount, surfacedNewest),
    estimateSource: bucketFmv != null ? "graded-bucket" : "raw-pool",
    // Signals iOS looks for on the wire but doesn't populate here —
    // Cardsight-only responses degrade gracefully when they're null.
    predictedRange: null,
    regime: null,
    regimeConfidence: null,
    // CF-CARDSIGHT-COMPLETE-COMPS (Drew, 2026-07-13, PR #416): emit EVERY
    // raw record — not just the top 5 — so iOS' Card Detail shows the full
    // comp history. Field names match iOS' CompIQPriceRecentComp decoder
    // (soldDate, imageUrl, saleType) plus price + title + url.
    recentComps: rawRecords.map((r) => ({
      price: r.price,
      soldDate: r.date ?? null,
      title: r.title ?? null,
      imageUrl: r.image_url ?? null,
      saleType: r.listing_type === "fixed"
        ? "Buy It Now"
        : r.listing_type === "auction"
          ? "Auction"
          : r.listing_type ?? null,
      belowMarket: false,
      url: r.url ?? null,
      source: "cardsight",
    })),
    // priceHistory shape: { soldDate, price, listingType }. Emit chronological
    // (oldest → newest) so iOS' priceHistoryContent regression math sees a
    // time-ordered series.
    priceHistory: rawRecords
      .slice()
      .filter((r) => typeof r.date === "string")
      .sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!))
      .map((r) => ({
        soldDate: r.date,
        price: r.price,
        listingType: r.listing_type ?? null,
      })),
    priceSource: "cardsight",
    gradeBreakdown: buildGradeBreakdown(pricing),
    gradedEstimates: [],
    nearestGradedAnchor: null,
    recommendation: null,
    // Attribution flag for KQL — NOT surfaced on the wire (shape lock).
    // Consumers filtering by source in prod queries will see the log
    // event `price_by_id_cardsight_uuid_route` (emitted at the route).
  };
}

/**
 * Build the per-grade breakdown iOS renders on the Card Detail grade
 * rail from Cardsight's graded records. Grouped by (company, grade)
 * with median + count.
 */
function buildGradeBreakdown(pricing: Awaited<ReturnType<typeof getPricing>>): any[] {
  const rows: any[] = [];
  for (const company of pricing.graded) {
    const graderLabel = company.company_name.toUpperCase().includes("PSA")
      ? "PSA"
      : company.company_name.toUpperCase().includes("BGS") ||
          company.company_name.toUpperCase().includes("BECKETT")
        ? "BGS"
        : company.company_name.toUpperCase().includes("SGC")
          ? "SGC"
          : company.company_name.toUpperCase().includes("CGC")
            ? "CGC"
            : null;
    if (!graderLabel) continue;
    for (const bucket of company.grades) {
      const gradeNum = Number(bucket.grade_value);
      if (!Number.isFinite(gradeNum) || gradeNum <= 0) continue;
      const prices = bucket.records
        .map((r) => r.price)
        .filter((p) => typeof p === "number" && p > 0);
      if (prices.length === 0) continue;
      const med = median(prices);
      if (med == null) continue;
      rows.push({
        grader: graderLabel,
        grade: gradeNum % 1 === 0 ? String(gradeNum) : gradeNum.toFixed(1),
        numericGrade: gradeNum,
        compCount: prices.length,
        weightedMedianPrice: Math.round(med * 100) / 100,
      });
    }
  }
  return rows;
}

/** Response shape when the card exists but Cardsight has no pricing yet. */
function buildEmptyPricingResponse(cardId: string, detail: any): any {
  return {
    success: true,
    cardId,
    fairMarketValueLive: null,
    marketValue: null,
    marketTier: { label: null, value: null },
    approximate: true,
    estimateBasis: null,
    predictedPrice: null,
    predictedPriceRange: null,
    predictedPriceAttribution: null,
    trendIQ: null,
    cardIdentity: {
      card_id: cardId,
      player: detail.name,
      set: detail.setName,
      release: detail.releaseName,
      year: detail.year,
      number: detail.number,
      parallel: null,
      title: `${detail.year ?? ""} ${detail.releaseName ?? ""} ${detail.setName ?? ""} ${detail.name} ${detail.number}`.trim(),
    },
    compsUsed: 0,
    compsAvailable: 0,
    daysSinceNewestComp: null,
    lastSale: null,
    confidence: 0,
    estimateSource: null,
    predictedRange: null,
    regime: null,
    regimeConfidence: null,
    recentComps: [],
    priceHistory: [],
    priceSource: "cardsight",
    gradeBreakdown: [],
    gradedEstimates: [],
    nearestGradedAnchor: null,
    recommendation: null,
  };
}
