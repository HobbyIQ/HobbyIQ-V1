import express, { Request, Response } from "express";
import { buildUniversalBaseballValuation } from "../services/valuation/universalBaseballValue";

const router = express.Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface CompIQSalePoint {
  price: number;
  date: string;
  grade?: string;
}

/** A comp from the same player + set but potentially a different grade, parallel, or serial.
 *  The backend normalizes the price to the target card's attributes before blending it in.
 */
interface CompIQNeighborComp {
  price: number;
  date: string;
  parallel?: string;     // neighbor's parallel (e.g. "Base" when target is "Refractor /99")
  grade?: string;        // neighbor's grade
  serialNumber?: number; // neighbor's print run
}

interface CompIQCardInput {
  playerName: string;
  cardName: string;
  cost: number;
  parallel?: string;
  grade?: string;
  serialNumber?: number;
  year?: number;
  brand?: string;
  setName?: string;
  cardNumber?: string;
  team?: string;
  auto?: boolean;
  relic?: boolean;
  variation?: boolean;
  rookie?: boolean;
  prospect?: boolean;
  hallOfFame?: boolean;
  playerDemandScore?: number;
  populationCount?: number;
  marketHeatScore?: number;
  activeListings?: number;        // current eBay active (unsold) listing count for supply scoring
  /** Cheapest current eBay BIN/offer price — tells us where sellers are anchored TODAY. */
  lowestActiveListingPrice?: number;
  /** Average ask price across current active listings. */
  avgActiveListingPrice?: number;
  /** How many times this card sold in the last 7 days (subset of recentComps window). */
  recentSoldCount7d?: number;
  /** Average age (days) of the current active eBay listings — stale listings signal weak demand. */
  avgListingAgeDays?: number;
  /** Free-text player/card event: "MVP race", "injury", "HOF ballot", "World Series", "trade", etc.
   *  Maps to a demand multiplier in computeTodaySignal(). */
  playerEvent?: string;

  // ── 24-hour intraday signals ───────────────────────────────────────────────
  // Markets can reprice within hours after a breakout performance, injury, or viral moment.
  // These fields let the engine detect demand spikes that happened in the last 24 hours.

  /** How many times this card sold in the last 24 hours (pulled from eBay sold feed). */
  recentSoldCount24h?: number;
  /** Active listing count as of ~24h ago (eBay snapshot). Compare to activeListings to detect floor sweeps. */
  activeListings24hAgo?: number;
  /** The lowest active BIN/offer price ~24h ago. Compare to lowestActiveListingPrice to detect floor drift. */
  lowestAsk24hAgo?: number;
  /** Average sale price of transactions completed in the last 24 hours. */
  avgSoldPrice24h?: number;

  recentComps?: CompIQSalePoint[];
  /** Comps from same player + set but different grade/parallel/serial.
   *  Backend normalizes each to the target card's attributes before blending. */
  neighborComps?: CompIQNeighborComp[];
}

// ─── Derive demand + supply signals from comp data ─────────────────────────

interface DerivedCompSignals {
  playerDemandScore: number;   // 0–100: derived from sale volume, recency, velocity
  marketHeatScore: number;     // 0–100: derived from sell-through rate when activeListings provided
  sellThroughRate: number;     // 0–1: raw sell-through ratio; 0.5 when no active listing data
  demandNote: string;
  supplyNote: string;
}

function deriveCompSignals(
  cleanPoints: { price: number; daysAgo: number }[],
  trendVelocityPct: number,
  activeListings?: number,
  soldCount7d?: number,        // optional: caller-supplied 7d sold count for more accurate STR
): DerivedCompSignals {
  // Demand score (0–100)
  // Three components: sale volume density, recency of newest sale, price velocity
  const recentSales = cleanPoints.filter((p) => p.daysAgo <= 30).length;
  const newestAge   = cleanPoints.length > 0 ? Math.min(...cleanPoints.map((p) => p.daysAgo)) : 999;

  const volumeScore   = Math.min(recentSales * 10, 40);                                              // 0–40
  const recencyScore  = newestAge <= 2 ? 30 : newestAge <= 7 ? 24 : newestAge <= 14 ? 16 : newestAge <= 30 ? 8 : 0; // 0–30
  const velocityScore = trendVelocityPct >= 0.1 ? 30 : trendVelocityPct >= 0.05 ? 22 : trendVelocityPct >= 0 ? 15 : trendVelocityPct >= -0.05 ? 7 : 0; // 0–30

  const playerDemandScore = Math.round(Math.min(volumeScore + recencyScore + velocityScore, 100));
  const demandNote = `Derived demand ${playerDemandScore}/100 from ${recentSales} sales ≤30d, newest ${newestAge}d ago, velocity ${(trendVelocityPct * 100).toFixed(1)}%.`;

  // Market heat score from sell-through rate (0–100)
  // sell-through = sold / (sold + active); high sell-through = tight supply = hot market
  let marketHeatScore = 50;   // neutral when no active listing data
  let supplyNote = "No active listing count supplied; market heat neutral.";
  let sellThroughRate = 0.5;  // neutral default

  if (activeListings !== undefined) {
    // Prefer caller-supplied 7d sold count; fall back to recent comp sample within 30d
    const recentSoldForSTR = soldCount7d !== undefined ? soldCount7d : recentSales;
    const strDenom = recentSoldForSTR + activeListings;
    sellThroughRate = strDenom > 0 ? recentSoldForSTR / strDenom : 0;
    marketHeatScore = Math.round(Math.min(sellThroughRate * 120, 100));
    const soldLabel = soldCount7d !== undefined ? `${soldCount7d} sold (7d)` : `${recentSoldForSTR} sold`;
    supplyNote = `${soldLabel} vs ${activeListings} active → sell-through ${(sellThroughRate * 100).toFixed(0)}% → market heat ${marketHeatScore}/100.`;
  }

  return { playerDemandScore, marketHeatScore, sellThroughRate, demandNote, supplyNote };
}

// ─── Grade multipliers for neighbor comp normalization ────────────────────────
// Two separate tables: ultra-modern/modern Chrome products have steeper grade cliffs
// than heritage/flagship products. Using the wrong table when normalizing a PSA 10
// Chrome comp to price a raw Heritage card would badly over-estimate the target.
//
// These are RELATIVE multipliers vs raw — used only for normalization math, not for
// final valuation (that's handled by universalBaseballValue.ts parseGradeMultiplier).

const GRADE_MULT_CHROME: Record<string, number> = {
  raw:        1.0,
  "psa 7":    1.10,
  "psa 8":    1.18,
  "psa 9":    1.55,
  "psa 10":   4.20,  // Chrome PSA 10 premium is legitimately 3-5× raw
  "bgs 9":    1.38,
  "bgs 9.5":  2.30,  // BGS 9.5 Gem is nearly as valued as PSA 10 on Chrome
  "bgs 10":   3.50,
  "sgc 9":    1.45,
  "sgc 10":   3.80,
  "cgc 10":   3.60,
};

const GRADE_MULT_FLAGSHIP: Record<string, number> = {
  raw:        1.0,
  "psa 7":    1.08,
  "psa 8":    1.14,
  "psa 9":    1.30,
  "psa 10":   1.90,  // Flagship PSA 10 premium is more modest
  "bgs 9":    1.20,
  "bgs 9.5":  1.50,
  "bgs 10":   2.00,
  "sgc 9":    1.25,
  "sgc 10":   1.75,
  "cgc 10":   1.70,
};

const GRADE_MULT_VINTAGE: Record<string, number> = {
  raw:       1.0,
  "psa 1":   0.60,
  "psa 2":   0.75,
  "psa 3":   0.88,
  "psa 4":   1.05,
  "psa 5":   1.18,
  "psa 6":   1.35,
  "psa 7":   1.65,
  "psa 8":   2.20,
  "psa 9":   3.80,
  "psa 10":  9.00,  // Vintage PSA 10 is astronomically rare — huge cliff
  "sgc 8":   1.90,
  "sgc 9":   3.20,
};

// Legacy flat table kept for fallback (used by getGradeNormMult when no era context)
const GRADE_MULTIPLIER: Record<string, number> = {
  raw:       1.0,
  "psa 7":   1.10,
  "psa 9":   1.50,
  "psa 10":  3.50,
  "bgs 9.5": 4.00,
  "bgs 10":  6.00,
  "sgc 10":  3.00,
  "cgc 10":  3.00,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(dateStr: string): number {
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function removeOutliers(prices: number[]): number[] {
  if (prices.length < 4) return prices;

  // IQR method for small sets (< 8 comps) — more robust than 2-sigma for thin data
  // For larger sets fall back to 2-sigma which handles fat tails better
  if (prices.length < 8) {
    const sorted = [...prices].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    const filtered = prices.filter(p => p >= lo && p <= hi);
    return filtered.length >= 2 ? filtered : prices; // never remove all data
  }

  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
  const std = Math.sqrt(variance);
  return prices.filter(p => Math.abs(p - mean) <= 2 * std);
}

// ─── Comp time decay (exponential) ──────────────────────────────────────────
// Exponential decay with half-life of 14 days: a comp from 14 days ago is worth
// half as much as one from today. Linear decay (previous: 1/(1+d/30)) treated a
// 7-day-old comp as 81% of a fresh comp; exponential treats it as 61% — much more
// realistic for a volatile market where last week's sale may already be stale.
function timeDecayWeight(daysAgo: number): number {
  return Math.exp(-daysAgo * Math.LN2 / 14); // half-life = 14 days
}

// ─── Comp relevance weight (grade + parallel + serial match bonus) ────────────
// A PSA 10 comp for a PSA 10 target is a perfect data point. A raw comp for a
// PSA 10 target is noisier after normalization. Grade match = +60%, parallel match
// = +30%, serial match = +20%. These are multiplicative bonuses on top of time decay.
function compRelevanceWeight(
  compGrade: string | undefined,
  compParallel: string | undefined,
  compSerial: number | undefined,
  targetGrade: string | undefined,
  targetParallel: string | undefined,
  targetSerial: number | undefined,
): number {
  let bonus = 1.0;
  const normalizeGrade  = (g?: string) => (g ?? "raw").toLowerCase().trim();
  const normalizeParallel = (p?: string) => (p ?? "base").toLowerCase().trim();

  if (normalizeGrade(compGrade) === normalizeGrade(targetGrade))  bonus *= 1.6;
  if (normalizeParallel(compParallel) === normalizeParallel(targetParallel)) bonus *= 1.3;
  if (compSerial !== undefined && targetSerial !== undefined && compSerial === targetSerial) bonus *= 1.2;
  return bonus;
}

function weightedMedian(points: { price: number; daysAgo: number; relevance?: number }[]): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0].price;
  const weighted = points.map(p => ({ price: p.price, w: timeDecayWeight(p.daysAgo) * (p.relevance ?? 1.0) }));
  const totalW = weighted.reduce((s, p) => s + p.w, 0);
  const sorted = [...weighted].sort((a, b) => a.price - b.price);
  let cumW = 0;
  const halfW = totalW / 2;
  for (const pt of sorted) {
    cumW += pt.w;
    if (cumW >= halfW) return pt.price;
  }
  return sorted[sorted.length - 1].price;
}

function weightedPercentile(points: { price: number; daysAgo: number; relevance?: number }[], pct: number): number {
  if (points.length === 0) return 0;
    const weighted = points.map(p => ({ price: p.price, w: timeDecayWeight(p.daysAgo) * (p.relevance ?? 1.0) }));
    const totalW = weighted.reduce((s, p) => s + p.w, 0);
    const sorted = [...weighted].sort((a, b) => a.price - b.price);
    const target = totalW * pct;
    let cumW = 0;
    for (const pt of sorted) {
      cumW += pt.w;
      if (cumW >= target) return pt.price;
    }
    return sorted[sorted.length - 1].price;
  }

  // ─── Comp price trajectory (price velocity) ──────────────────────────────────
// Weighted linear regression over the exact comp time series for this specific card.
// If prices are consistently rising ($40 → $55 → $68 over 3 weeks), the weighted
// median undershoots the actual current price. The regression intercept (price at
// daysAgo=0) tells us where the trend lands today.
//
// Returns a multiplier to nudge anchorFMV toward the regression's today-price.
// Only 50% of the gap is applied (conservative — comps are data, trend is inference).
// Requires ≥3 comp points and a reasonably strong fit (R² ≥ 0.30) to activate.

interface CompPriceTrendResult {
  slopePerDay:    number;           // $/day; positive = rising prices
  pctPerWeek:     number;           // % change per 7 days (relative to median)
  predictedToday: number;           // regression intercept at daysAgo=0
  rSquared:       number;           // 0–1; fit quality
  multiplier:     number;           // FMV nudge (1.0 = no adjustment)
  confidence:     "strong" | "moderate" | "weak" | "none";
  note:           string | null;
}

function computeCompPriceTrend(
  points: { price: number; daysAgo: number; relevance?: number }[],
  anchorMedian: number,
): CompPriceTrendResult {
  const none: CompPriceTrendResult = { slopePerDay: 0, pctPerWeek: 0, predictedToday: anchorMedian, rSquared: 0, multiplier: 1.0, confidence: "none", note: null };

  // Need at least 3 data points spanning at least 5 days to fit a meaningful line
  if (points.length < 3 || anchorMedian <= 0) return none;
  const sorted = [...points].sort((a, b) => a.daysAgo - b.daysAgo);  // oldest first
  const minAge = sorted[0].daysAgo;
  const maxAge = sorted[sorted.length - 1].daysAgo;
  if (maxAge - minAge < 5) return none;  // all comps within 5 days — no trend signal

  // x = -daysAgo (so daysAgo=0 is the present, older = more negative x)
  // weight = timeDecayWeight * relevance — same weighting as the median
  const pts = points.map(p => ({
    x: -p.daysAgo,
    y: p.price,
    w: timeDecayWeight(p.daysAgo) * (p.relevance ?? 1.0),
  }));

  const sumW   = pts.reduce((s, p) => s + p.w, 0);
  const sumWX  = pts.reduce((s, p) => s + p.w * p.x, 0);
  const sumWY  = pts.reduce((s, p) => s + p.w * p.y, 0);
  const sumWXX = pts.reduce((s, p) => s + p.w * p.x * p.x, 0);
  const sumWXY = pts.reduce((s, p) => s + p.w * p.x * p.y, 0);

  const denom = sumW * sumWXX - sumWX * sumWX;
  if (Math.abs(denom) < 1e-10) return none;  // degenerate (all x identical)

  const slope     = (sumW * sumWXY - sumWX * sumWY) / denom;   // $/day (positive = rising)
  const intercept = (sumWY - slope * sumWX) / sumW;            // predicted price at x=0 (today)

  // ── R² (weighted) ────────────────────────────────────────────────────────
  const yMean = sumWY / sumW;
  const ssTot = pts.reduce((s, p) => s + p.w * (p.y - yMean) ** 2, 0);
  const ssRes = pts.reduce((s, p) => s + p.w * (p.y - (slope * p.x + intercept)) ** 2, 0);
  const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  const pctPerWeek = anchorMedian > 0 ? round2((slope * 7) / anchorMedian) : 0;

  // ── Confidence based on data points + R² ─────────────────────────────────
  const confidence: CompPriceTrendResult["confidence"] =
    rSquared >= 0.70 && points.length >= 5 ? "strong"   :
    rSquared >= 0.45 && points.length >= 3 ? "moderate" :
    rSquared >= 0.30 && points.length >= 3 ? "weak"     :
    "none";

  if (confidence === "none") return { ...none, slopePerDay: slope, pctPerWeek, predictedToday: intercept, rSquared };

  // ── Multiplier: nudge anchorFMV toward the regression's today-price ───────
  // Apply 50% of the gap (conservative) — trend confirms direction but comps are facts.
  // Cap the nudge at ±20% of the anchor to prevent runaway extrapolation.
  const raw      = (intercept - anchorMedian) / anchorMedian;
  const confidenceFactor = confidence === "strong" ? 0.60 : confidence === "moderate" ? 0.45 : 0.30;
  const nudge    = Math.max(-0.20, Math.min(0.20, raw * confidenceFactor));
  const multiplier = round2(1.0 + nudge);

  // Only activate if the trend is meaningful (>3% implied nudge)
  if (Math.abs(nudge) < 0.03) return { slopePerDay: slope, pctPerWeek, predictedToday: intercept, rSquared, multiplier: 1.0, confidence, note: null };

  const dir    = slope > 0 ? "rising" : "falling";
  const pctWk  = (Math.abs(pctPerWeek) * 100).toFixed(1);
  const note = `Comp price trend ${dir} ${pctWk}%/wk (R²=${rSquared.toFixed(2)}, ${points.length} pts, ${confidence} fit) → regression predicts $${intercept.toFixed(0)} today vs. $${anchorMedian.toFixed(0)} median → ${(nudge * 100 > 0 ? "+" : "")}${(nudge * 100).toFixed(1)}% anchor nudge.`;

  return { slopePerDay: slope, pctPerWeek, predictedToday: round2(intercept), rSquared, multiplier, confidence, note };
}

function getSellFormat(
  finalFMV: number,
  trendDirection: "up" | "down" | "flat",
  demandScore: number,
  serialNumber?: number,
  compCount?: number,
  grade?: string,
): { format: string; reason: string } {
  const isSerial = serialNumber !== undefined;
  const isScarce = isSerial && serialNumber! <= 50;
  const isHighGrade = /psa 10|bgs 9\.5|bgs 10/i.test(grade ?? "");

  // Auction wins when scarcity + demand make bidders compete for the price
  if (isScarce && (trendDirection === "up" || demandScore >= 65)) {
    return {
      format: "eBay Auction",
      reason: `Serial /${serialNumber} with ${trendDirection === "up" ? "rising trend" : "strong demand"} — let bidders set the ceiling.`,
    };
  }

  // Auction also wins when the market is hot but supply is unknown
  if (trendDirection === "up" && demandScore >= 70) {
    return {
      format: "eBay Auction",
      reason: "Hot demand + upward trend — auction captures momentum premium.",
    };
  }

  // High-grade slabs on a stable/established product sell better as fixed BIN
  if (isHighGrade && finalFMV >= 75) {
    return {
      format: "eBay BIN",
      reason: `Graded ${grade} at $${finalFMV.toFixed(0)} — stable slab value suits a firm Buy It Now price.`,
    };
  }

  // Thin comp markets: patient sell via COMC or marketplace
  if ((compCount ?? 0) <= 1 && finalFMV < 50) {
    return {
      format: "COMC / Marketplace",
      reason: "Low comp density and modest value — set a patient price on COMC or a hobby marketplace.",
    };
  }

  // Default: BIN with Best Offer lets buyer negotiate while protecting floor
  return {
    format: "eBay BIN w/ Best Offer",
    reason: "Standard market conditions — list at suggested price and accept offers above your min.",
  };
}

// ─── Neighbor comp normalization ─────────────────────────────────────────────

const PARALLEL_NORM_MULT: Record<string, number> = {
  base: 1.0, refractor: 1.06, prism: 1.06, shimmer: 1.06, mojo: 1.06, "x-fractor": 1.06,
  green: 1.10, purple: 1.08, blue: 1.12, aqua: 1.12, teal: 1.12,
  gold: 1.20, black: 1.18, sapphire: 1.18, orange: 1.32, red: 1.45,
  "printing plate": 1.55, ssp: 1.34, "super short print": 1.34,
  "golden mirror": 1.34, "image variation": 1.18, variation: 1.18,
  superfractor: 2.2,
};

function getParallelNormMult(parallel?: string): number {
  if (!parallel) return 1.0;
  const key = parallel.toLowerCase().trim();
  for (const [k, v] of Object.entries(PARALLEL_NORM_MULT)) {
    if (key.includes(k)) return v;
  }
  return 1.02; // minor non-base premium
}

function getGradeNormMult(grade?: string, era?: "chrome" | "flagship" | "vintage"): number {
  const key = (grade ?? "raw").toLowerCase().trim();
  if (era === "chrome")   return GRADE_MULT_CHROME[key]   ?? GRADE_MULTIPLIER[key] ?? 1.0;
  if (era === "flagship") return GRADE_MULT_FLAGSHIP[key] ?? GRADE_MULTIPLIER[key] ?? 1.0;
  if (era === "vintage")  return GRADE_MULT_VINTAGE[key]  ?? GRADE_MULTIPLIER[key] ?? 1.0;
  return GRADE_MULTIPLIER[key] ?? 1.0;
}

function getSerialNormMult(serial?: number): number {
  if (!serial) return 1.0;
  if (serial <= 1)   return 2.4;
  if (serial <= 5)   return 1.8;
  if (serial <= 10)  return 1.55;
  if (serial <= 25)  return 1.35;
  if (serial <= 50)  return 1.22;
  if (serial <= 99)  return 1.12;
  if (serial <= 199) return 1.08;
  if (serial <= 299) return 1.05;
  if (serial <= 499) return 1.03;
  return 1.0;
}

/** Normalize a neighbor comp price to what it would be for the target card's attributes.
 *  Divides out the neighbor's multipliers, multiplies in the target's.
 *  @param era  'chrome' | 'flagship' | 'vintage' | undefined — selects the correct grade table */
function normalizeNeighborPrice(
  neighborPrice: number,
  neighborGrade: string | undefined,
  neighborParallel: string | undefined,
  neighborSerial: number | undefined,
  targetGrade: string | undefined,
  targetParallel: string | undefined,
  targetSerial: number | undefined,
  era?: "chrome" | "flagship" | "vintage",
): number {
  const nMult = getGradeNormMult(neighborGrade, era) * getParallelNormMult(neighborParallel) * getSerialNormMult(neighborSerial);
  const tMult = getGradeNormMult(targetGrade, era)   * getParallelNormMult(targetParallel)   * getSerialNormMult(targetSerial);
  const ratio = nMult > 0 ? tMult / nMult : 1.0;
  // Cap to ±10× to prevent runaway extrapolation from very dissimilar cards
  return neighborPrice * Math.min(Math.max(ratio, 0.1), 10.0);
}

/** Compute a market drift factor: how much have neighboring cards' prices moved
 *  in the period AFTER the newest exact comp?  Applied to stale exact comps to
 *  bring them current without re-fetching eBay.
 *  Returns driftFactor = 1.0 when exact comps are fresh (≤7 days) or data is insufficient. */
function computeMarketDrift(
  exactPoints: { price: number; daysAgo: number }[],
  neighborPoints: { price: number; daysAgo: number }[],
): { driftFactor: number; driftNote: string } {
  if (exactPoints.length === 0 || neighborPoints.length === 0) {
    return { driftFactor: 1.0, driftNote: "No drift applied — insufficient data." };
  }
  const newestExactAge = Math.min(...exactPoints.map(p => p.daysAgo));
  if (newestExactAge <= 7) {
    return { driftFactor: 1.0, driftNote: `Exact comps fresh (${newestExactAge}d old) — no drift correction needed.` };
  }
  // Neighbor comps more recent than the newest exact comp → "after" window
  const afterNeighbors  = neighborPoints.filter(p => p.daysAgo < newestExactAge);
  // Neighbor comps overlapping with exact comp window → "before" baseline
  const beforeNeighbors = neighborPoints.filter(p => p.daysAgo >= newestExactAge);
  if (afterNeighbors.length === 0 || beforeNeighbors.length === 0) {
    return { driftFactor: 1.0, driftNote: "No drift applied — neighbor comps don't straddle the exact comp window." };
  }
  const beforeAvg = beforeNeighbors.reduce((s, p) => s + p.price, 0) / beforeNeighbors.length;
  const afterAvg  = afterNeighbors.reduce((s, p) => s + p.price, 0)  / afterNeighbors.length;
  if (beforeAvg <= 0) return { driftFactor: 1.0, driftNote: "No drift applied — zero baseline price." };
  const rawDrift    = (afterAvg - beforeAvg) / beforeAvg;
  const cappedDrift = Math.max(-0.30, Math.min(0.30, rawDrift)); // cap ±30% to prevent runaway extrapolation
  return {
    driftFactor: round2(1 + cappedDrift),
    driftNote:   `Market drifted ${(cappedDrift * 100).toFixed(1)}% since ${newestExactAge}d-old exact comp (neighbor before avg $${beforeAvg.toFixed(0)} → after avg $${afterAvg.toFixed(0)}, ${afterNeighbors.length} post-comp sale(s)).`,
  };
}

function detectTrend(points: { price: number; daysAgo: number }[]): {
  direction: "up" | "down" | "flat";
  strength: "strong" | "moderate" | "weak";
  velocityPct: number;
} {
  if (points.length < 3) return { direction: "flat", strength: "weak", velocityPct: 0 };
  const sorted = [...points].sort((a, b) => b.daysAgo - a.daysAgo); // oldest first
  const half = Math.floor(sorted.length / 2);
  const older = sorted.slice(0, half).map(p => p.price);
  const newer = sorted.slice(half).map(p => p.price);
  const oldAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const newAvg = newer.reduce((a, b) => a + b, 0) / newer.length;
  const velocity = oldAvg > 0 ? (newAvg - oldAvg) / oldAvg : 0;
  const direction: "up" | "down" | "flat" = velocity > 0.03 ? "up" : velocity < -0.03 ? "down" : "flat";
  const strength: "strong" | "moderate" | "weak" =
    Math.abs(velocity) >= 0.15 ? "strong" : Math.abs(velocity) >= 0.06 ? "moderate" : "weak";
  return { direction, strength, velocityPct: velocity };
}

function getScarcityAdj(serialNumber?: number): number {
  if (!serialNumber) return 1.0;
  if (serialNumber <= 10)  return 1.25;
  if (serialNumber <= 25)  return 1.15;
  if (serialNumber <= 50)  return 1.10;
  if (serialNumber <= 100) return 1.05;
  return 1.0;
}

function getOutlook(roi: number, trendDir: string, compTrendWeekly?: number | null, momentum?: string | null): string {
  // Bearish convergence: regression shows sustained decline AND 24h momentum is cold
  if ((compTrendWeekly ?? 0) <= -0.07 && momentum === "cold") return roi < 0.05 ? "sell" : "watch";
  if ((compTrendWeekly ?? 0) <= -0.05 && momentum === "cold") return roi < 0.10 ? "watch" : "hold";
  // Standard ROI-based logic
  if (roi >= 0.20 && trendDir !== "down") return "buy";
  if (roi >= 0.08) return "buy";
  if (roi >= -0.05) return "hold";
  if (roi >= -0.15) return "watch";
  return "sell";
}

function getAction(outlook: string): string {
  switch (outlook) {
    case "buy":   return "buy";
    case "hold":  return "hold";
    case "watch": return "reduce";
    case "sell":  return "sell";
    default:      return "hold";
  }
}

function getInvestmentScore(roi: number, confidence: number, trend: string, compTrendWeekly?: number | null): number {
  let score = Math.round(50 + roi * 100);
  score = Math.max(5, Math.min(95, score));
  score = Math.round(score * (0.6 + 0.4 * (confidence / 100)));
  // Use regression-based weekly velocity when available — more precise than direction label alone
  if (compTrendWeekly !== null && compTrendWeekly !== undefined) {
    const trendImpact = Math.round(compTrendWeekly * 100 * 1.5); // e.g., −7%/wk → −11 pts
    score = Math.max(5, Math.min(95, score + trendImpact));
  } else {
    if (trend === "up")   score = Math.min(95, score + 5);
    if (trend === "down") score = Math.max(5, score - 5);
  }
  return score;
}

function getInvestmentRating(score: number): string {
  if (score >= 80) return "Strong Buy";
  if (score >= 65) return "Buy";
  if (score >= 50) return "Hold";   // raised from 45 → better alignment with action labels
  if (score >= 32) return "Reduce";
  return "Sell";
}

// ─── Player event → demand multiplier ────────────────────────────────────────

const PLAYER_EVENT_MULTIPLIERS: Array<{ keys: string[]; mult: number; label: string }> = [
  { keys: ["hall of fame", "hof", "inducted"],       mult: 1.35, label: "HOF induction/ballot" },
  { keys: ["cy young", "mvp", "hank aaron", "silver slugger", "gold glove", "rookie of the year"], mult: 1.20, label: "Award winner/finalist" },
  { keys: ["world series", "fall classic"],          mult: 1.18, label: "World Series run" },
  { keys: ["playoff", "alcs", "nlcs", "alds", "nlds", "wild card"], mult: 1.12, label: "Playoff run" },
  { keys: ["big market", "trade", "new team"],       mult: 1.08, label: "Trade/big-market move" },
  { keys: ["milestone", "3000 hits", "500 hr", "record", "no-hitter", "perfect game"], mult: 1.15, label: "Milestone/record" },
  { keys: ["breakout", "hot", "trending", "viral"],  mult: 1.10, label: "Viral/breakout moment" },
  { keys: ["retire", "retirement", "retired"],       mult: 0.92, label: "Retirement announcement" },
  { keys: ["demotion", "minors", "optioned"],        mult: 0.85, label: "Demotion to minors" },
  { keys: ["slump", "struggling"],                   mult: 0.90, label: "Extended slump" },
  { keys: ["injury", "injured", " il ", "disabled list", "torn", "fracture", "surgery"], mult: 0.75, label: "Injury/IL" },
  { keys: ["suspension", "suspended", "ped", "ban"], mult: 0.65, label: "Suspension/ban" },
];

function getPlayerEventMultiplier(playerEvent?: string): { mult: number; label: string } {
  if (!playerEvent) return { mult: 1.0, label: "" };
  const lower = ` ${playerEvent.toLowerCase()} `;
  for (const entry of PLAYER_EVENT_MULTIPLIERS) {
    if (entry.keys.some(k => lower.includes(k))) {
      return { mult: entry.mult, label: entry.label };
    }
  }
  return { mult: 1.0, label: "Unknown event — no multiplier applied" };
}

// ─── Today signal: ask spread + velocity acceleration + player event ──────────
//
//  Combines three real-time market signals into a single "today multiplier"
//  applied to the FMV AFTER the universal valuation engine runs:
//
//    1. Ask spread  — are current sellers priced above/below the last sale?
//    2. Velocity    — are sales accelerating vs. the 30d baseline?
//    3. Player event— did something news-worthy happen today?

function computeTodaySignal(params: {
  lowestAsk?:          number;
  avgAsk?:             number;
  lastSoldRef:         number;    // most recent exact comp price, or anchorFMV if none
  soldTotal30d:        number;    // # exact comps in last 30d
  recentSoldCount7d?:  number;    // # sold in last 7d (subset)
  avgListingAgeDays?:  number;    // avg age of current active listings
  playerEvent?:        string;
}): { multiplier: number; notes: string[]; velocityAcceleration: number | null; askSpreadPct: number | null } {
  const notes: string[] = [];
  let combined = 1.0;

  // ── 1. Ask spread ─────────────────────────────────────────────────────────
  let askSpreadPct: number | null = null;
  if (params.lowestAsk && params.lastSoldRef > 0) {
    const raw = (params.lowestAsk - params.lastSoldRef) / params.lastSoldRef;
    askSpreadPct = round2(raw);
    const listingsFresh = (params.avgListingAgeDays ?? 30) <= 10;

    if (raw > 0.10 && listingsFresh) {
      // Sellers are anchored meaningfully above the last sale AND listings are fresh
      // → nudge FMV up by 40% of the gap (conservative; let comps lead, asks confirm)
      const nudge = Math.min(0.25, raw * 0.4);
      combined *= (1 + nudge);
      notes.push(`Ask spread +${(raw * 100).toFixed(0)}% (lowest ask $${params.lowestAsk.toFixed(0)} vs last sold $${params.lastSoldRef.toFixed(0)}, listings ${params.avgListingAgeDays ?? "?"}d old) → +${(nudge * 100).toFixed(1)}% today signal.`);
    } else if (raw < -0.10) {
      // Sellers are underwater vs. last sale → market softened
      const nudge = Math.max(-0.20, raw * 0.35);
      combined *= (1 + nudge);
      notes.push(`Ask spread ${(raw * 100).toFixed(0)}% (lowest ask $${params.lowestAsk.toFixed(0)} below last sold $${params.lastSoldRef.toFixed(0)}) → ${(nudge * 100).toFixed(1)}% today signal.`);
    } else {
      notes.push(`Ask spread ${(raw * 100).toFixed(1)}% — within normal range, no adjustment.`);
    }
  }

  // ── 2. Velocity acceleration ──────────────────────────────────────────────
  let velocityAcceleration: number | null = null;
  if (params.recentSoldCount7d && params.soldTotal30d > 0) {
    const rate7d  = params.recentSoldCount7d / 7;
    const rate30d = params.soldTotal30d / 30;
    if (rate30d > 0) {
      velocityAcceleration = round2(rate7d / rate30d);
      if (velocityAcceleration >= 3.0) {
        combined *= 1.10;
        notes.push(`Velocity 3×+ baseline (${params.recentSoldCount7d} sold in 7d vs ${params.soldTotal30d} over 30d) → +10% demand signal.`);
      } else if (velocityAcceleration >= 2.0) {
        combined *= 1.05;
        notes.push(`Velocity 2× baseline (${params.recentSoldCount7d} sold in 7d) → +5% demand signal.`);
      } else if (velocityAcceleration <= 0.3 && params.soldTotal30d >= 4) {
        combined *= 0.96;
        notes.push(`Velocity slowing (${params.recentSoldCount7d} sold in last 7d vs ${params.soldTotal30d} over 30d) → −4% demand signal.`);
      } else {
        notes.push(`Velocity ${velocityAcceleration.toFixed(2)}× baseline — normal, no adjustment.`);
      }
    }
  }

  // ── 3. Player event ───────────────────────────────────────────────────────
  const { mult: eventMult, label: eventLabel } = getPlayerEventMultiplier(params.playerEvent);
  if (eventMult !== 1.0) {
    combined *= eventMult;
    notes.push(`Player event "${params.playerEvent}" (${eventLabel}) → ×${eventMult.toFixed(2)}.`);
  }

  // ── Cap total today signal to ±40% ───────────────────────────────────────
  const cappedMultiplier = round2(Math.max(0.60, Math.min(1.40, combined)));
  if (cappedMultiplier !== combined) {
    notes.push(`Today signal capped at ${((cappedMultiplier - 1) * 100).toFixed(1)}% (raw was ${((combined - 1) * 100).toFixed(1)}%).`);
  }

  return { multiplier: cappedMultiplier, notes, velocityAcceleration, askSpreadPct };
}

// ─── 24-hour intraday momentum signal ────────────────────────────────────────
// Detects demand changes that have happened in the past 24 hours — the window where
// a player performance, injury, or viral moment actually moves card prices.
// This runs AFTER computeTodaySignal and stacks multiplicatively with it.
// Cap is tighter (±25%) because 24h signals are inherently noisier.

function compute24hSignal(params: {
  recentSoldCount24h?:    number;   // sales in last 24h
  recentSoldCount7d?:     number;   // sales in last 7d (to derive daily baseline)
  activeListings?:        number;   // current active listing count
  activeListings24hAgo?:  number;   // listing count ~24h ago
  lowestAsk?:             number;   // current cheapest BIN
  lowestAsk24hAgo?:       number;   // cheapest BIN ~24h ago
  avgSoldPrice24h?:       number;   // avg sale price in last 24h
  compMedianRef:          number;   // weighted median of comps (used as price anchor)
}): { multiplier: number; notes: string[]; momentum: "hot" | "cold" | "neutral" } {
  const notes: string[] = [];
  let combined = 1.0;

  // ── Signal A: 24h velocity spike vs. 7d daily rate ────────────────────────
  // Rate today vs. daily average this week. A 4× spike means something happened.
  if (params.recentSoldCount24h !== undefined && params.recentSoldCount7d !== undefined && params.recentSoldCount7d > 0) {
    const dailyAvg7d = params.recentSoldCount7d / 7;
    const rate24h = params.recentSoldCount24h;
    if (dailyAvg7d > 0) {
      const spike = rate24h / dailyAvg7d;
      if (spike >= 5.0) {
        combined *= 1.20;
        notes.push(`24h velocity spike ${spike.toFixed(1)}× daily average (${rate24h} sold in 24h vs ${dailyAvg7d.toFixed(1)}/day) → +20% momentum signal.`);
      } else if (spike >= 3.0) {
        combined *= 1.12;
        notes.push(`24h velocity ${spike.toFixed(1)}× daily average — strong demand surge → +12%.`);
      } else if (spike >= 2.0) {
        combined *= 1.06;
        notes.push(`24h velocity ${spike.toFixed(1)}× daily average — elevated demand → +6%.`);
      } else if (spike < 0.3 && params.recentSoldCount7d >= 3) {
        // Sudden demand drought — market went cold
        combined *= 0.96;
        notes.push(`24h sales nearly zero vs. ${dailyAvg7d.toFixed(1)}/day baseline — demand cooling → −4%.`);
      }
    }
  } else if (params.recentSoldCount24h !== undefined && params.recentSoldCount24h >= 3) {
    // No 7d baseline yet — any 24h sales ≥3 without history suggests a new spike
    combined *= 1.07;
    notes.push(`${params.recentSoldCount24h} sales in last 24h with no prior baseline — elevated demand → +7%.`);
  }

  // ── Signal B: Inventory shrinkage (floor sweep detection) ─────────────────
  // If listings dropped meaningfully in 24h, buyers are actively sweeping the floor.
  // This precedes a price floor move by hours.
  if (params.activeListings !== undefined && params.activeListings24hAgo !== undefined && params.activeListings24hAgo > 0) {
    const shrinkage = (params.activeListings24hAgo - params.activeListings) / params.activeListings24hAgo;
    if (shrinkage >= 0.50) {
      // Half the supply gone in 24h — floor is being swept
      combined *= 1.15;
      notes.push(`Inventory down ${(shrinkage * 100).toFixed(0)}% in 24h (${params.activeListings24hAgo} → ${params.activeListings} listings) — active floor sweep → +15%.`);
    } else if (shrinkage >= 0.30) {
      combined *= 1.08;
      notes.push(`Inventory down ${(shrinkage * 100).toFixed(0)}% in 24h — supply tightening → +8%.`);
    } else if (shrinkage <= -0.40 && params.activeListings24hAgo >= 3) {
      // Listings flooded in — sellers entering market, price pressure downward
      combined *= 0.95;
      notes.push(`Inventory up ${(Math.abs(shrinkage) * 100).toFixed(0)}% in 24h — sellers flooding market → −5%.`);
    }
  }

  // ── Signal C: Price floor drift (sellers already repriced) ────────────────
  // If the cheapest BIN moved significantly in 24h, the market has already
  // repriced and comps are stale by definition.
  if (params.lowestAsk !== undefined && params.lowestAsk24hAgo !== undefined && params.lowestAsk24hAgo > 0) {
    const floorDrift = (params.lowestAsk - params.lowestAsk24hAgo) / params.lowestAsk24hAgo;
    if (floorDrift >= 0.20) {
      combined *= 1.14;
      notes.push(`Ask floor up ${(floorDrift * 100).toFixed(0)}% in 24h ($${params.lowestAsk24hAgo.toFixed(0)} → $${params.lowestAsk.toFixed(0)}) — sellers repriced, comps may be stale → +14%.`);
    } else if (floorDrift >= 0.10) {
      combined *= 1.07;
      notes.push(`Ask floor up ${(floorDrift * 100).toFixed(0)}% in 24h — floor moving up → +7%.`);
    } else if (floorDrift <= -0.15) {
      combined *= 0.93;
      notes.push(`Ask floor dropped ${(Math.abs(floorDrift) * 100).toFixed(0)}% in 24h — sellers cutting prices → −7%.`);
    } else if (floorDrift <= -0.08) {
      combined *= 0.97;
      notes.push(`Ask floor down ${(Math.abs(floorDrift) * 100).toFixed(0)}% in 24h — slight softening → −3%.`);
    }
  }

  // ── Signal D: 24h avg sold vs. comp median ────────────────────────────────
  // If cards are actually clearing higher than the historical comp median TODAY,
  // the market has already moved. This is the most direct signal.
  if (params.avgSoldPrice24h !== undefined && params.compMedianRef > 0) {
    const lift = (params.avgSoldPrice24h - params.compMedianRef) / params.compMedianRef;
    if (lift >= 0.25) {
      combined *= 1.18;
      notes.push(`24h avg sale $${params.avgSoldPrice24h.toFixed(0)} is ${(lift * 100).toFixed(0)}% above comp median — market has repriced upward → +18%.`);
    } else if (lift >= 0.12) {
      combined *= 1.09;
      notes.push(`24h avg sale $${params.avgSoldPrice24h.toFixed(0)} is ${(lift * 100).toFixed(0)}% above comp median → +9%.`);
    } else if (lift <= -0.15) {
      combined *= 0.91;
      notes.push(`24h avg sale $${params.avgSoldPrice24h.toFixed(0)} is ${(Math.abs(lift) * 100).toFixed(0)}% below comp median — market has softened → −9%.`);
    } else if (lift <= -0.08) {
      combined *= 0.96;
      notes.push(`24h avg sale slightly below comp median → −4%.`);
    }
  }

  // ── Cap to ±25% (24h signals are inherently noisy) ───────────────────────
  const cappedMultiplier = round2(Math.max(0.75, Math.min(1.25, combined)));
  if (cappedMultiplier !== combined) {
    notes.push(`24h signal capped at ${((cappedMultiplier - 1) * 100).toFixed(1)}% (raw was ${((combined - 1) * 100).toFixed(1)}%).`);
  }

  const momentum: "hot" | "cold" | "neutral" =
    cappedMultiplier >= 1.10 ? "hot" :
    cappedMultiplier <= 0.95 ? "cold" :  // lowered from 0.92 — catches stacked mild bearish signals
    "neutral";

  return { multiplier: cappedMultiplier, notes, momentum };
}

// ─── Market regime synthesis ──────────────────────────────────────────────────
// Combines all directional signals into a single regime score (−65 to +65).
// Contributions: comp regression trend (±30), 24h momentum (±20), supply heat (±15).
// Used to produce smarter listing prices and more precise outlook labels.
function computeMarketRegime(params: {
  compTrendPctPerWeek:  number | null;
  compTrendConfidence:  string;         // "strong" | "moderate" | "weak" | "none"
  signal24hMomentum:    "hot" | "cold" | "neutral";
  marketHeatScore:      number;         // 0–100
}): { score: number; label: "strong-bull" | "bull" | "neutral" | "bear" | "strong-bear" } {
  let score = 0;

  // Comp trend contribution: ±30 pts (weighted by regression confidence quality)
  if (params.compTrendPctPerWeek !== null && params.compTrendConfidence !== "none") {
    const qualityFactor =
      params.compTrendConfidence === "strong"   ? 1.0 :
      params.compTrendConfidence === "moderate" ? 0.70 : 0.40;
    const raw = Math.round(params.compTrendPctPerWeek * 100 * qualityFactor * 3);
    score += Math.max(-30, Math.min(30, raw));
  }

  // 24h momentum contribution: ±20 pts
  score += params.signal24hMomentum === "hot" ? 20 : params.signal24hMomentum === "cold" ? -20 : 0;

  // Supply heat contribution: ±15 pts
  score += params.marketHeatScore > 60 ?  15 :
           params.marketHeatScore > 40 ?   0 :
           params.marketHeatScore > 20 ?  -7 :
                                          -15;

  const label: "strong-bull" | "bull" | "neutral" | "bear" | "strong-bear" =
    score >= 40 ? "strong-bull" :
    score >= 15 ? "bull"        :
    score <= -40 ? "strong-bear" :
    score <= -15 ? "bear"        :
    "neutral";

  return { score, label };
}

// ─── Core estimator ──────────────────────────────────────────────────────────

function estimateCard(card: CompIQCardInput): Record<string, unknown> {
  const path: string[] = [];

  // 1. Collect data points — attach relevance score to each exact comp
  //    (exact comps for the same grade/parallel/serial score higher → more weight in median)
  const rawPoints: CompIQSalePoint[] = (card.recentComps ?? []).filter((c) => c.price > 0);
  const allPoints = rawPoints.map((c) => ({
    price: c.price,
    daysAgo: daysBetween(c.date),
    relevance: compRelevanceWeight(c.grade, undefined, undefined, card.grade, card.parallel, card.serialNumber),
  }));

  const gradeKey = (card.grade ?? "raw").toLowerCase();
  const gradeMultiplier = GRADE_MULTIPLIER[gradeKey] ?? 1.0;
  const scarAdj = getScarcityAdj(card.serialNumber);
  const parallel = card.parallel ?? "Base";

  // Derive grade normalization era from brand/set name for accurate cross-grade comp normalization
  const cardText = `${card.brand ?? ""} ${card.setName ?? ""} ${card.cardName ?? ""}`.toLowerCase();
  const normEra: "chrome" | "flagship" | "vintage" | undefined =
    /chrome|bowman|finest|prizm|optic|select|mosaic|refractor|sapphire/.test(cardText) ? "chrome" :
    /heritage|archives|topps \d{4}|flagship|stadium club|allen ginter|gypsy queen/.test(cardText) ? "flagship" :
    /(19[0-9]{2}|20[0-0][0-9])/.test(cardText) || (card.year !== undefined && card.year < 1980) ? "vintage" :
    undefined;

  // 2. Remove outliers from exact comps (preserving relevance weights)
  const cleanPricesSet = new Set(removeOutliers(allPoints.map((p) => p.price)));
  const cleanPoints = allPoints.filter((p) => cleanPricesSet.has(p.price));

  // 3. Normalize neighbor comps to the target card's grade/parallel/serial
  //    Neighbor comps get a lower baseline relevance than exact comps but still
  //    carry relevance bonuses when their attributes happen to match the target.
  const neighborRaw: CompIQNeighborComp[] = (card.neighborComps ?? []).filter(c => c.price > 0);
  const neighborNormalized = neighborRaw.map(c => ({
    price: normalizeNeighborPrice(c.price, c.grade, c.parallel, c.serialNumber, card.grade, card.parallel, card.serialNumber, normEra),
    daysAgo: daysBetween(c.date),
    // Base relevance 0.5 for a neighbor (not an exact match), boosted if attributes align
    relevance: 0.5 * compRelevanceWeight(c.grade, c.parallel, c.serialNumber, card.grade, card.parallel, card.serialNumber),
  }));
  const recentNeighbors = neighborNormalized.filter(p => p.daysAgo <= 60);

  // 4. Market drift: how much have neighboring cards moved SINCE the newest exact comp?
  //    This corrects stale exact comps by applying the market's observed movement.
  const { driftFactor, driftNote } = computeMarketDrift(cleanPoints, neighborNormalized);
  path.push(`Market drift: ${driftNote}`);

  // 5. Blend exact + neighbor comps into a single anchor set.
  //    Priority: exact comps first; neighbor comps fill in when exact is sparse.
  let anchorPoints: { price: number; daysAgo: number }[];
  let usedNeighborComps = false;
  let neighborCompReason: string | null = null;

  if (cleanPoints.length >= 3) {
    // Strong exact data — keep exact prices, apply drift correction for staleness
    anchorPoints = cleanPoints.map(p => ({ ...p, price: round2(p.price * driftFactor) }));
    if (driftFactor !== 1.0 && recentNeighbors.length > 0) {
      usedNeighborComps = true;
      neighborCompReason = `${cleanPoints.length} exact comps drift-corrected ${((driftFactor - 1) * 100).toFixed(1)}% from ${recentNeighbors.length} neighbor comp(s).`;
    }
  } else if (cleanPoints.length >= 1 && recentNeighbors.length > 0) {
    // Thin exact comps — blend 65% exact / 35% neighbor, then apply drift
    const exactMedian    = weightedMedian(cleanPoints);
    const neighborMedian = weightedMedian(recentNeighbors);
    const blended        = round2((exactMedian * 0.65 + neighborMedian * 0.35) * driftFactor);
    anchorPoints = [{ price: blended, daysAgo: 0 }];
    usedNeighborComps = true;
    neighborCompReason = `Blended ${cleanPoints.length} exact (65%) + ${recentNeighbors.length} neighbor (35%), drift ${((driftFactor - 1) * 100).toFixed(1)}%.`;
  } else if (cleanPoints.length === 0 && recentNeighbors.length > 0) {
    // No exact comps — use neighbor anchor entirely
    anchorPoints = recentNeighbors.map(p => ({ ...p, price: round2(p.price * driftFactor) }));
    usedNeighborComps = true;
    neighborCompReason = `No exact comps — anchoring from ${recentNeighbors.length} normalized neighbor comp(s).`;
  } else {
    // No comps of any kind — fall back to cost
    anchorPoints = [{ price: card.cost, daysAgo: 0 }];
  }

  // Derive final method string now that we know whether neighbor comps contributed
  const method = cleanPoints.length >= 3 ? "exact-recent-comps" :
    cleanPoints.length >= 1 && usedNeighborComps ? "hybrid+neighbor" :
    cleanPoints.length >= 1 ? "hybrid" :
    usedNeighborComps ? "neighbor-comp-normalized" :
    "baseline-multiplier-fallback";

  path.push(`Method: ${method}`);
  path.push(`Data: ${anchorPoints.length} anchor point(s) (exact: ${cleanPoints.length}, neighbor: ${recentNeighbors.length})`);
  if (neighborCompReason) path.push(`Neighbor: ${neighborCompReason}`);

  // 6. Weighted stats from final anchor set
  const fmv  = weightedMedian(anchorPoints);
  const low  = weightedPercentile(anchorPoints, 0.25);
  const high = weightedPercentile(anchorPoints, 0.75);
  path.push(`Raw FMV: $${fmv.toFixed(2)}, low $${low.toFixed(2)}, high $${high.toFixed(2)}`);

  // 7. Apply ±15% band when only 1 anchor point
  const anchorFMV  = round2(fmv);
  const anchorLow  = anchorPoints.length === 1 ? round2(anchorFMV * 0.85) : round2(low);
  const anchorHigh = anchorPoints.length === 1 ? round2(anchorFMV * 1.15) : round2(high);

  // 8. Trend — use exact comps when 2+ available; fall back to exact+neighbor combined
  const trendPoints = cleanPoints.length >= 2 ? cleanPoints : [...cleanPoints, ...recentNeighbors];
  const trend = detectTrend(trendPoints);
  const trendAdj = trend.direction === "up" ? 1.02 : trend.direction === "down" ? 0.98 : 1.0;
  path.push(`Trend: ${trend.direction} (${trend.strength}, ${(trend.velocityPct * 100).toFixed(1)}% velocity)`);

  // 8b. Derive demand + supply signals from ALL comp data (exact + neighbor combined)
  // 8b. Comp price trajectory — weighted linear regression over exact comp time series.
  //     If prices are consistently $40→$55→$68 over 3 weeks, the weighted median
  //     undershoots reality. Regression predicts where today's price lands.
  //     Nudge fraction: 60% of gap for strong fit, 45% moderate, 30% weak. Cap ±20%.
  const compTrend = computeCompPriceTrend(cleanPoints, anchorFMV);
  let trendAdjustedAnchor = anchorFMV;
  let trendAdjustedLow  = anchorLow;
  let trendAdjustedHigh = anchorHigh;
  if (compTrend.multiplier !== 1.0) {
    trendAdjustedAnchor = round2(anchorFMV  * compTrend.multiplier);
    trendAdjustedLow    = round2(anchorLow  * compTrend.multiplier);
    trendAdjustedHigh   = round2(anchorHigh * compTrend.multiplier);
    path.push(`Comp trajectory ×${compTrend.multiplier.toFixed(3)} → anchor $${anchorFMV.toFixed(2)} → $${trendAdjustedAnchor.toFixed(2)}`);
  }
  if (compTrend.note) path.push(`  Trajectory: ${compTrend.note}`);

  // 8c. Derive demand + supply signals from ALL comp data (exact + neighbor combined)
  const compSignals = deriveCompSignals([...cleanPoints, ...recentNeighbors], trend.velocityPct, card.activeListings, card.recentSoldCount7d);
  const resolvedDemandScore  = card.playerDemandScore  ?? compSignals.playerDemandScore;
  const resolvedMarketHeat   = card.marketHeatScore    ?? compSignals.marketHeatScore;
  path.push(`Signals: ${compSignals.demandNote}`);
  path.push(`Supply: ${compSignals.supplyNote}`);

  // 8. Forward projection
  // Use the freshest data from either exact or neighbor comps for confidence scoring
  const allAvailablePoints = [...cleanPoints, ...recentNeighbors];
  const newestAge = allAvailablePoints.length > 0 ? Math.min(...allAvailablePoints.map((p) => p.daysAgo)) : 0;

  const valuation = buildUniversalBaseballValuation({
    ...card,
      anchorValue: trendAdjustedAnchor,
      lowAnchor:   trendAdjustedLow,
      highAnchor:  trendAdjustedHigh,
    compCount: cleanPoints.length,
    newestCompAge: newestAge,
    trendVelocityPct: trend.velocityPct,
    playerDemandScore: resolvedDemandScore,
    marketHeatScore:   resolvedMarketHeat,
  });

  let confScore = valuation.confidenceScore;
  // Trend-aware confidence penalty: a fast-falling card is harder to price accurately
  // even with many comps — the market may have moved further than the comp data shows.
  if (compTrend.pctPerWeek <= -0.08 && compTrend.confidence !== "none" && compTrend.confidence !== "weak") {
    confScore = Math.max(0, confScore - 7);
    path.push(`Confidence −7: strong downtrend (${(compTrend.pctPerWeek * 100).toFixed(1)}%/wk) increases pricing uncertainty.`);
  } else if (compTrend.pctPerWeek <= -0.05 && compTrend.confidence !== "none") {
    confScore = Math.max(0, confScore - 4);
    path.push(`Confidence −4: moderate downtrend (${(compTrend.pctPerWeek * 100).toFixed(1)}%/wk).`);
  }
  const confFraction = round2(confScore / 100);
  let finalFMV = valuation.finalValue;
  const finalLow = valuation.finalLow;
  const finalHigh = valuation.finalHigh;

  // ── Today signal: ask spread + velocity acceleration + player event ───────
  // The most recent exact comp price is our "last sold" reference.
  // Fall back to anchorFMV if we have no exact comps.
  const lastSoldRef = cleanPoints.length > 0
    ? cleanPoints.reduce((a, b) => (a.daysAgo < b.daysAgo ? a : b)).price
    : anchorFMV;
  const soldTotal30d = cleanPoints.filter(p => p.daysAgo <= 30).length;

  const todaySignal = computeTodaySignal({
    lowestAsk:         card.lowestActiveListingPrice,
    avgAsk:            card.avgActiveListingPrice,
    lastSoldRef,
    soldTotal30d,
    recentSoldCount7d: card.recentSoldCount7d,
    avgListingAgeDays: card.avgListingAgeDays,
    playerEvent:       card.playerEvent,
  });

  if (todaySignal.multiplier !== 1.0) {
    finalFMV = round2(finalFMV * todaySignal.multiplier);
    path.push(`Today signal ×${todaySignal.multiplier.toFixed(3)} → adjusted FMV $${finalFMV.toFixed(2)}`);
  }
  for (const note of todaySignal.notes) {
    path.push(`  Today: ${note}`);
  }

  // ── 24h intraday signal: velocity spike + floor sweep + floor drift + cleared price ──
  // Runs after todaySignal; stacks multiplicatively. Cap ±25% (intraday is noisy).
  const signal24h = compute24hSignal({
    recentSoldCount24h:   card.recentSoldCount24h,
    recentSoldCount7d:    card.recentSoldCount7d,
    activeListings:       card.activeListings,
    activeListings24hAgo: card.activeListings24hAgo,
    lowestAsk:            card.lowestActiveListingPrice,
    lowestAsk24hAgo:      card.lowestAsk24hAgo,
    avgSoldPrice24h:      card.avgSoldPrice24h,
    compMedianRef:        anchorFMV,   // the pre-signal FMV is the best available comp median
  });

  if (signal24h.multiplier !== 1.0) {
    finalFMV = round2(finalFMV * signal24h.multiplier);
    path.push(`24h signal ×${signal24h.multiplier.toFixed(3)} (${signal24h.momentum}) → adjusted FMV $${finalFMV.toFixed(2)}`);
  }
  for (const note of signal24h.notes) {
    path.push(`  24h: ${note}`);
  }

  // ── Data freshness warning ─────────────────────────────────────────────────
  let dataFreshnessWarning: string | null = null;
  if (newestAge > 21 && driftFactor === 1.0) {
    dataFreshnessWarning = `Newest comp is ${newestAge}d old with no drift correction — treat this as an estimate. Run a fresh eBay search to update.`;
  } else if (newestAge > 14 && driftFactor === 1.0) {
    dataFreshnessWarning = `Comps are ${newestAge}d old — price may not reflect today's market. Check for recent sales.`;
  } else if (newestAge > 7) {
    dataFreshnessWarning = `Comps are ${newestAge}d old — monitor for movement.`;
  }
  if (dataFreshnessWarning) path.push(`Freshness: ${dataFreshnessWarning}`);

  // Staleness discount: very stale comps with no drift correction get a small haircut
  // to reflect the compounding uncertainty of where the market truly is today.
  let stalenessPenalty = 1.0;
  if (newestAge > 21 && driftFactor === 1.0) {
    stalenessPenalty = 0.97;
    finalFMV = round2(finalFMV * stalenessPenalty);
    path.push(`Staleness haircut ×0.97 — newest comp is ${newestAge}d old with no drift correction.`);
  }

  const quickSale = round2(finalFMV * 0.88);
  const fwd30 = round2(finalFMV * (1 + trend.velocityPct));
  const bear30 = round2(finalFMV * 0.9);
  const bull30 = round2(finalFMV * 1.12);
  const gradeAdj = cleanPoints.length === 0 ? 1.0 : gradeMultiplier;
  path.push(...valuation.summary);
  path.push(`Confidence reasons: ${valuation.confidenceReasons.join(" | ")}`);
  for (const entry of valuation.breakdown) {
    path.push(`${entry.label}: ${entry.effectiveMultiplier.toFixed(2)}x (${entry.reason})`);
  }

  // 10. Outlook + investment score
  const roi = card.cost > 0 ? (finalFMV - card.cost) / card.cost : 0;
  // Synthesize all directional signals into a market regime for smarter pricing decisions
  const marketRegime = computeMarketRegime({
    compTrendPctPerWeek: compTrend.confidence !== "none" ? compTrend.pctPerWeek : null,
    compTrendConfidence: compTrend.confidence,
    signal24hMomentum:   signal24h.momentum,
    marketHeatScore:     resolvedMarketHeat,
  });
  const outlook = getOutlook(
    roi, trend.direction,
    compTrend.confidence !== "none" ? compTrend.pctPerWeek : null,
    signal24h.momentum !== "neutral" ? signal24h.momentum : null,
  );
  const action  = getAction(outlook);
  const invScore  = getInvestmentScore(
    roi, confScore, trend.direction,
    compTrend.confidence !== "none" ? compTrend.pctPerWeek : null,
  );
  const invRating = getInvestmentRating(invScore);
  path.push(`ROI: ${(roi * 100).toFixed(1)}%, regime: ${marketRegime.label} (${marketRegime.score}), outlook: ${outlook}, score: ${invScore}`);

  // 11. Action prices
  const entryMax    = round2(finalFMV * 0.90);
  const trimMin     = round2(finalFMV * 1.08);
  const stopLoss    = round2(Math.min(card.cost * 0.85, finalFMV * 0.80));
  const recheckDays = marketRegime.label === "strong-bear" ? 2 : trend.direction === "up" ? 7 : trend.direction === "down" ? 3 : 14;

  // 11b. Seller output prices — adaptive markup driven by sell-through rate and trend direction
  const str = compSignals.sellThroughRate;
  const trendWeekly = compTrend.confidence !== "none" ? compTrend.pctPerWeek : 0;
  let listMarkup = str < 0.15 ? 0.00       // oversupplied: price at FMV to compete
                 : str < 0.35 ? 0.05       // soft: +5%
                 : str < 0.60 ? 0.08       // normal: +8%
                 : str < 0.80 ? 0.12       // hot: +12%
                 :              0.16;      // very hot (STR ≥80%): +16%
  if (trendWeekly <= -0.05) listMarkup = Math.max(0, listMarkup - 0.04);   // falling: trim markup
  if (trendWeekly >= 0.05)  listMarkup = Math.min(0.18, listMarkup + 0.02); // rising: slight boost
  const listingMarkupPct    = round2(listMarkup * 100);
  const suggestedListPrice  = round2(finalFMV * (1 + listMarkup));
  // Min acceptable floor: wider in strong downtrend (holding longer = more loss)
  const minFloorFraction    = trendWeekly <= -0.07 ? 0.78 : 0.82;
  const minAcceptableOffer  = round2(Math.max(card.cost, finalFMV * minFloorFraction));
  const sellFormatResult    = getSellFormat(finalFMV, trend.direction, resolvedDemandScore, card.serialNumber, cleanPoints.length, card.grade);

  // 12. Evidence quality
  const evidenceScore = Math.min(100, Math.round(confScore * 0.9 + (cleanPoints.length > 0 ? 10 : 0)));
  const evidenceLevel = evidenceScore >= 75 ? "strong" : evidenceScore >= 50 ? "moderate" : "weak";

  const summary =
    `${card.playerName} — FMV $${finalFMV.toFixed(0)} (${confScore}% confidence). ` +
    (roi >= 0.05 ? `Up ${(roi * 100).toFixed(0)}% vs cost. ` : roi < -0.05 ? `Down ${Math.abs(roi * 100).toFixed(0)}% vs cost. ` : "") +
    `Trend: ${trend.direction}.`;

  const actionRationale =
    action === "buy"    ? `FMV $${finalFMV.toFixed(0)} is ${(roi * 100).toFixed(0)}% above cost. Market trending ${trend.direction}.`
    : action === "sell" ? `FMV $${finalFMV.toFixed(0)} is below your cost of $${card.cost.toFixed(0)}. Limit downside.`
    : action === "reduce" ? `Marginal upside at FMV $${finalFMV.toFixed(0)}. Trim at $${trimMin.toFixed(0)} to de-risk.`
    : `Fairly valued near cost. Hold and monitor thread.`;

  return {
    // Seller output — the 5 primary fields
    value:                finalFMV,
    suggestedListPrice,
    minAcceptableOffer,
    quickSaleValue:       quickSale,
    sellFormat:           sellFormatResult.format,
    sellFormatReason:     sellFormatResult.reason,
    // Full valuation detail (preserved for breakdown / disclosure layers)
    baseAnchorValue:       anchorFMV,
    fairValue:            finalFMV,
    lowValue:             finalLow,
    highValue:            finalHigh,
    confidence:           confFraction,
    confidenceScore:      confScore,
    confidenceLabel:      valuation.confidenceLabel,
    method,
    compCount:            cleanPoints.length,
    targetParallel:       parallel,
    anchorParallel:       null,
    usedNeighboringComps: usedNeighborComps,
    neighborCompReason:   neighborCompReason,
    driftFactor:          driftFactor,
    // Today signal — real-time market correction applied on top of comp-based FMV
    todaySignalMultiplier:    todaySignal.multiplier !== 1.0 ? todaySignal.multiplier : null,
    todaySignalNotes:         todaySignal.notes.length > 0 ? todaySignal.notes : null,
    askSpreadPct:             todaySignal.askSpreadPct,
    velocityAcceleration:     todaySignal.velocityAcceleration,
    playerEvent:              card.playerEvent ?? null,
    dataFreshnessWarning,
    // 24h intraday signal — detects demand changes within the last 24 hours
    signal24hMultiplier:      signal24h.multiplier !== 1.0 ? signal24h.multiplier : null,
    signal24hNotes:           signal24h.notes.length > 0 ? signal24h.notes : null,
    signal24hMomentum:        signal24h.momentum !== "neutral" ? signal24h.momentum : null,
      // Comp price trajectory — linear regression over the comp time series for this card
      compTrendMultiplier:      compTrend.multiplier !== 1.0 ? compTrend.multiplier : null,
      compTrendSlopePerDay:     compTrend.confidence !== "none" ? compTrend.slopePerDay : null,
      compTrendPctPerWeek:      compTrend.confidence !== "none" ? compTrend.pctPerWeek  : null,
      compTrendRSquared:        compTrend.confidence !== "none" ? compTrend.rSquared     : null,
      compTrendConfidence:      compTrend.confidence !== "none" ? compTrend.confidence  : null,
      compTrendPredictedToday:  compTrend.confidence !== "none" ? compTrend.predictedToday : null,
    multiplierUsed:       valuation.appliedMultiplier,
    scarcityAdjustment:   scarAdj,
    trendAdjustment:      trendAdj,
    gradeAdjustment:      gradeAdj,
    productFamily:        valuation.profile.family,
    productProfile:       valuation.profile.label,
    parsedIdentity:       valuation.identity,
    valuationModel:       "universal-baseball-v1",
    liquidityAdjustment:  valuation.liquidityAdjustment,
    marketHeatAdjustment: valuation.marketHeatAdjustment,
    multiplierBreakdown:  valuation.breakdown,
    trending:             trend.direction !== "flat",
    trendDirection:       trend.direction,
    trendStrength:        trend.strength,
    trendVelocityPct:     trend.velocityPct,
    newestCompAge:        newestAge,
    forwardValue30d:      fwd30,
    bearValue30d:         bear30,
    bullValue30d:         bull30,
    outlook,
    investmentScore:      invScore,
    investmentRating:     invRating,
    evidenceQualityScore: evidenceScore,
    evidenceQualityLevel: evidenceLevel,
    recommendedAction:    action,
    actionEntryMax:       entryMax,
    actionTrimMin:        trimMin,
    actionStopLoss:       stopLoss,
    actionRecheckDays:    recheckDays,
    actionRationale,
    summary,
    pricingPath:          path,
    // Derived demand + supply signals (always present; sourced from comps or caller-override)
    derivedDemandScore:   resolvedDemandScore,
    derivedMarketHeat:    resolvedMarketHeat,
    demandSignalNote:     compSignals.demandNote,
    supplySignalNote:     compSignals.supplyNote,
    marketRegimeScore:    marketRegime.score,
    marketRegimeLabel:    marketRegime.label,
    stalenessPenalty:     stalenessPenalty !== 1.0 ? stalenessPenalty : null,
    listingMarkupPct,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", module: "CompIQ" });
});

// POST /api/compiq/bulk-estimate
router.post("/bulk-estimate", (req: Request, res: Response) => {
  const { cards } = req.body ?? {};
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: "cards array is required" });
  }
  const results: Record<string, unknown>[] = [];
  for (const card of cards) {
    if (!card.playerName || !card.cardName || typeof card.cost !== "number" || card.cost <= 0) {
      return res.status(400).json({ error: "Each card requires playerName, cardName, and a positive cost" });
    }
    results.push(estimateCard(card as CompIQCardInput));
  }
  return res.json({ results });
});

// POST /api/compiq/estimate (single-card convenience wrapper)
router.post("/estimate", (req: Request, res: Response) => {
  const card = req.body as CompIQCardInput;
  if (!card?.playerName || !card?.cardName || typeof card?.cost !== "number" || card.cost <= 0) {
    return res.status(400).json({ error: "playerName, cardName, and a positive cost are required" });
  }
  return res.json(estimateCard(card));
});

export default router;
