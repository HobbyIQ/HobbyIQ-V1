import { Request, Response } from "express";
import { CompIQEstimateRequest } from "../../types/compiq.types.js";
import { DynamicPricingOrchestrator } from "../../modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js";
import { normalizeGradeCompany, normalizeParallel } from "./normalizationDictionary.service.js";
import { findCompsByQuery, getCardSales, searchCards, type CardHedgeCard } from "./cardhedge.client.js";
import { writeTrendSnapshot } from "../playerScore/trendHistory.service.js";
import { updatePlayerScoreFromEstimate } from "../playerScore/playerScore.service.js";
import { buildEngineMeta } from "./engineMeta.js";

// ---------------------------------------------------------------------------
// Card Hedge AI comp fetch (primary sold-data source — replaces Apify/eBay)
// ---------------------------------------------------------------------------

interface RawComp {
  price: number;
  title: string;
  soldDate: string;
}

interface RegimeSummary {
  regime: "momentum" | "mean-reversion" | "illiquid" | "stable";
  volatilityPct: number;
  slopePctPerComp: number;
  confidence: number;
  note: string;
}

function detectMarketRegime(comps: RawComp[]): RegimeSummary {
  if (comps.length < 3) {
    return {
      regime: "illiquid",
      volatilityPct: 0,
      slopePctPerComp: 0,
      confidence: 0.25,
      note: "Low comp count; market treated as illiquid.",
    };
  }

  const prices = comps.map((c) => c.price).filter((p) => Number.isFinite(p) && p > 0);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((acc, p) => acc + (p - avg) * (p - avg), 0) / Math.max(1, prices.length - 1);
  const stdDev = Math.sqrt(Math.max(variance, 0));
  const volatilityPct = avg > 0 ? (stdDev / avg) * 100 : 0;

  const first = prices[0] ?? avg;
  const last = prices[prices.length - 1] ?? avg;
  const slopePctPerComp = first > 0 ? (((last - first) / first) * 100) / Math.max(1, prices.length - 1) : 0;

  if (volatilityPct > 35) {
    return {
      regime: "illiquid",
      volatilityPct,
      slopePctPerComp,
      confidence: 0.55,
      note: "Wide price dispersion indicates thin or fragmented liquidity.",
    };
  }

  if (slopePctPerComp > 1.5) {
    return {
      regime: "momentum",
      volatilityPct,
      slopePctPerComp,
      confidence: 0.68,
      note: "Recent comps are accelerating upward.",
    };
  }

  if (slopePctPerComp < -1.5) {
    return {
      regime: "mean-reversion",
      volatilityPct,
      slopePctPerComp,
      confidence: 0.66,
      note: "Recent comps are cooling after prior highs.",
    };
  }

  return {
    regime: "stable",
    volatilityPct,
    slopePctPerComp,
    confidence: 0.62,
    note: "Comps are clustered with no strong directional drift.",
  };
}

/**
 * Fetch recent sold comps from Card Hedge AI.
 *
 * Card Hedge is the authoritative sold-data source for CompIQ. We previously
 * called the Apify eBay actor here; that path returned 0 results in
 * production and has been removed entirely per the "no more apify" directive.
 *
 * Flow: free-text query → identifyCard() (AI match, requires ≥0.80 confidence)
 * with searchCards() fallback → getCardSales() for that card_id.
 *
 * Returns [] on any failure so the calling pipeline falls through to its
 * existing fallback estimate cleanly.
 */
interface FetchedComps {
  comps: RawComp[];
  card: {
    card_id: string;
    title: string | null;
    player: string | null;
    set: string | null;
    year: string | number | null;
    number: string | null;
    variant: string | null;
  } | null;
  variantWarning: string[];
  /**
   * Sport category from Card Hedge's AI match (e.g. "Baseball",
   * "Basketball"). Null when no AI match, low confidence, or pinned-id
   * path (where category is not resolved). Consumed by the unsupported-
   * sport guard in computeEstimate.
   */
  aiCategory: string | null;
}

/**
 * Broader-pool trend signal.
 * Anchors stay pinned to the exact card_id's direct sales. The trend %
 * comes from ALL similar cards (same player + year + set, every variant)
 * so a thin/rare card with only 2 direct comps still gets a market-wide
 * direction reading instead of a flat noise number.
 */
export interface BroaderTrend {
  impliedTrendPct: number;
  direction: "up" | "down" | "flat";
  recentMedian: number | null;
  olderMedian: number | null;
  recentCount: number;
  olderCount: number;
  similarCardsScanned: number;
  totalSamples: number;
  windowRecentDays: number;
  windowOlderDays: number;
  basedOn: "exact" | "broader" | "insufficient";
}

// ---------------------------------------------------------------------------
// Velocity-weighted recency (Pricing Accuracy — Improvement 1)
// ---------------------------------------------------------------------------
// Sales from the last 48 hours carry 5x the weight of 3-week-old sales so the
// anchor price responds to recent market moves instead of lagging behind.
export function getSaleVelocityWeight(saleDate: string | number | Date | null | undefined): number {
  if (!saleDate) return 0.1;
  const ts = typeof saleDate === "number" ? saleDate : Date.parse(String(saleDate));
  if (!Number.isFinite(ts)) return 0.1;
  const hoursAgo = (Date.now() - ts) / (1000 * 60 * 60);
  if (hoursAgo <= 48) return 5.0;   // last 48h — hyper recent
  if (hoursAgo <= 168) return 2.0;  // last 7d — recent
  if (hoursAgo <= 504) return 1.0;  // last 21d — standard
  if (hoursAgo <= 720) return 0.3;  // last 30d — stale
  return 0.1;                        // older than 30d — very stale
}

/**
 * Continuous weighted-median: returns the price at which cumulative weight
 * first crosses half of the total. Falls back to the highest-priced sample
 * when weights are degenerate.
 */
export function computeWeightedMedian(
  samples: ReadonlyArray<{ price: number; date: string | number | Date | null | undefined }>
): number | null {
  if (samples.length === 0) return null;
  const weighted = samples
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .map((s) => ({ price: s.price, weight: getSaleVelocityWeight(s.date) }))
    .sort((a, b) => a.price - b.price);
  if (weighted.length === 0) return null;
  const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight <= 0) return weighted[Math.floor(weighted.length / 2)].price;
  const half = totalWeight / 2;
  let cum = 0;
  for (const item of weighted) {
    cum += item.weight;
    if (cum >= half) return item.price;
  }
  return weighted[weighted.length - 1].price;
}

// ---------------------------------------------------------------------------
// Comp quality filter (Pricing Accuracy — Improvement 2)
// ---------------------------------------------------------------------------
// Order matters — more specific phrases must precede their shorter prefixes
// so e.g. "lot of" matches before "lot ".
const EXCLUSION_KEYWORDS: ReadonlyArray<string> = [
  // Lot sales (specific first)
  "lot of", "lot ", "bundle", "collection", "bulk", "wholesale",
  "3 card", "5 card", "10 card", "set of", "group of",
  // Damaged / altered
  "damaged", "creased", "crease", "bent", "water damage", "flaw", "flawed",
  "trimmed", "altered", "restored", "fake", "reprint",
  // Redemption / not actual card
  "redemption", "placeholder", "digital",
  // Test / sample
  "prototype", "sample card", "test print",
];

interface CardIdentityLite {
  player?: string | null;
  year?: string | number | null;
  set?: string | null;
}

interface CompQualityVerdict {
  include: boolean;
  reason: string;
}

function scoreCompQuality(sale: RawComp, _card: CardIdentityLite): CompQualityVerdict {
  const title = (sale.title ?? "").toLowerCase();
  if (!title || !Number.isFinite(sale.price) || sale.price <= 0) {
    return { include: false, reason: "invalid" };
  }
  for (const kw of EXCLUSION_KEYWORDS) {
    if (title.includes(kw)) return { include: false, reason: `keyword:${kw.trim()}` };
  }
  return { include: true, reason: "ok" };
}

/**
 * Robust outlier trim using Median Absolute Deviation (MAD). A single wild
 * sale cannot inflate the spread the way it does with mean/σ, so this catches
 * real outliers even on small (n≥4) samples. Threshold uses the standard
 * modified-z-score cutoff: |0.6745·(p − median) / MAD| > 3.5.
 * Skipped when sample size < 4 or when the distribution is degenerate.
 */
function filterPriceOutliers(sales: RawComp[]): { kept: RawComp[]; removed: number } {
  if (sales.length < 4) return { kept: sales, removed: 0 };
  const prices = sales.map((s) => s.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const absDevs = prices.map((p) => Math.abs(p - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)];
  if (mad <= 0) {
    // Degenerate spread — fall back to mean/σ so we still trim something useful
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev <= 0) return { kept: sales, removed: 0 };
    const kept = sales.filter((s) => Math.abs(s.price - mean) <= stdDev * 2.5);
    return { kept, removed: sales.length - kept.length };
  }
  const kept = sales.filter((s) => Math.abs(0.6745 * (s.price - median) / mad) <= 3.5);
  return { kept, removed: sales.length - kept.length };
}

interface CompQualityResult {
  filtered: RawComp[];
  excluded: number;
  reasons: Record<string, number>;
}

export function applyCompQualityFilter(sales: RawComp[], card: CardIdentityLite): CompQualityResult {
  const reasons: Record<string, number> = {};
  const passed: RawComp[] = [];
  for (const s of sales) {
    const verdict = scoreCompQuality(s, card);
    if (verdict.include) {
      passed.push(s);
    } else {
      reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
    }
  }
  const { kept, removed } = filterPriceOutliers(passed);
  if (removed > 0) reasons["outlier"] = (reasons["outlier"] ?? 0) + removed;
  return {
    filtered: kept,
    excluded: sales.length - kept.length,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Grader premium coefficients (Pricing Accuracy — Improvement 3)
// ---------------------------------------------------------------------------
// Approximate market premiums vs a raw/ungraded baseline (=1.0). These are
// starting values; tune over time with backtest data.
const GRADER_PREMIUMS: Record<string, Record<string, number>> = {
  PSA: {
    "10": 4.0,
    "9":  1.7,
    "8":  1.15,
    "7":  0.95,
    "6":  0.85,
    "5":  0.75,
  },
  BGS: {
    "10":  6.0,
    "9.5": 3.5,
    "9":   1.6,
    "8.5": 1.2,
    "8":   1.05,
  },
  SGC: {
    "10":  3.4,
    "9.5": 2.6,
    "9":   1.5,
    "8.5": 1.15,
    "8":   1.0,
  },
  CGC: {
    "10":  3.2,
    "9.5": 2.4,
    "9":   1.45,
    "8.5": 1.12,
    "8":   0.98,
  },
};

export function getGraderPremium(
  gradingCompany: string | null | undefined,
  grade: string | null | undefined
): number {
  if (!gradingCompany || grade == null) return 1.0;
  const company = String(gradingCompany).toUpperCase().trim();
  const gradeKey = String(grade).trim();
  return GRADER_PREMIUMS[company]?.[gradeKey] ?? 1.0;
}

/** Extracts a (company, grade) tuple from a free-text comp title, or null. */
export function detectGradeFromTitle(title: string): { company: string; grade: string } | null {
  if (!title) return null;
  const m = title.match(/\b(PSA|BGS|SGC|CGC)\s*([0-9]+(?:\.5)?)\b/i);
  if (!m) return null;
  return { company: m[1].toUpperCase(), grade: m[2] };
}

/**
 * Format a comp title's detected grade as a display label
 * (e.g. "PSA 7", "BGS 9.5"). Returns "Raw" when no grading
 * company is detectable from the title — this matches the
 * convention used elsewhere in the engine where unknown /
 * undetectable grade is treated as Raw (premium 1.0).
 *
 * Used by `recentComps` display so the iOS UI can label each
 * comp's grade explicitly without parsing the title client-side.
 * See issue #24 for the design decision.
 */
export function formatGradeLabel(title: string): string {
  const d = detectGradeFromTitle(title);
  return d ? `${d.company} ${d.grade}` : "Raw";
}

/**
 * Normalize a graded comp price back to its raw equivalent so PSA10 sales,
 * BGS9.5 sales, and raw sales can pool into one anchor.
 */
export function normalizeCompToRaw(sale: RawComp): number {
  const detected = detectGradeFromTitle(sale.title);
  if (!detected) return sale.price;
  const premium = getGraderPremium(detected.company, detected.grade);
  return premium > 0 ? sale.price / premium : sale.price;
}

export function applyGraderPremium(rawPrice: number, company: string | null, grade: string | null): number {
  const premium = getGraderPremium(company, grade);
  return rawPrice * premium;
}

// ---------------------------------------------------------------------------
// Data sufficiency gate (Pricing Accuracy — Improvement 4)
// ---------------------------------------------------------------------------
interface DataSufficiency {
  sufficient: boolean;
  level: "none" | "very_thin" | "thin" | "adequate";
  message: string;
}

const MINIMUM_COMPS_FOR_POINT_ESTIMATE = 3;

export function evaluateDataSufficiency(params: {
  usedComps: number;
  totalComps: number;
  recentCount: number;
}): DataSufficiency {
  const { usedComps, totalComps, recentCount } = params;
  if (usedComps === 0) {
    return {
      sufficient: false,
      level: "none",
      message: totalComps === 0
        ? "No recent sales found for this card."
        : `Found ${totalComps} sales but none passed quality checks.`,
    };
  }
  if (usedComps < MINIMUM_COMPS_FOR_POINT_ESTIMATE) {
    return {
      sufficient: false,
      level: "very_thin",
      message: `Only ${usedComps} usable sale${usedComps === 1 ? "" : "s"} — not enough to publish a point price.`,
    };
  }
  if (usedComps < 6 || recentCount < 2) {
    return {
      sufficient: true,
      level: "thin",
      message: `Thin data — based on ${usedComps} sales (${recentCount} in last 14d). Treat as approximate.`,
    };
  }
  return { sufficient: true, level: "adequate", message: "" };
}

// ── Selling Guidance ─────────────────────────────────────────────────────
// Translate the model's price lanes + comp pool into the four numbers a
// seller actually wants to see on screen:
//   - sellRange       low/high band you'd realistically realize
//   - quickSale       price that closes within ~48h (under-cut the floor)
//   - fair            balanced FMV (mid of the band)
//   - ebayListing     the BIN sticker price to post (above FMV to allow
//                     best-offer haggling and the eBay 13% fee)
//   - bestOfferFloor  the lowest best-offer you should accept
//   - auctionStart    a no-reserve auction starting bid
//   - breakEven       the gross sale price you need to net `fair` after
//                     default fees + shipping
// All values respect the data-sufficiency gate — if we suppressed the
// point estimate, every number in this block is null.
export interface SellingGuidance {
  sellRange: { low: number; high: number } | null;
  quickSale: number | null;
  fair: number | null;
  ebayListingPrice: number | null;
  bestOfferFloor: number | null;
  auctionStartPrice: number | null;
  breakEven: number | null;
  recommendedPlatform: "auction" | "buy_it_now" | "best_offer" | "wait";
  notes: string[];
  assumptions: { feePct: number; shippingCost: number };
}

export function buildSellingGuidance(params: {
  quickSaleValue: number | null;
  fairMarketValue: number | null;
  premiumValue: number | null;
  comps: Array<{ price: number; date?: string | null }>;
  recommendedMethod?: string | null;
  marketSpeed?: string | null;
  demand?: string | null;
  feePct?: number;
  shippingCost?: number;
}): SellingGuidance {
  const feePct = params.feePct ?? 0.13; // eBay managed payments ~13% blended
  const shippingCost = params.shippingCost ?? 1.0; // PWE included; seller eats label on raw

  const fair = typeof params.fairMarketValue === "number" ? params.fairMarketValue : null;
  const quick = typeof params.quickSaleValue === "number" ? params.quickSaleValue : null;
  const premium = typeof params.premiumValue === "number" ? params.premiumValue : null;

  if (fair == null) {
    return {
      sellRange: null,
      quickSale: null,
      fair: null,
      ebayListingPrice: null,
      bestOfferFloor: null,
      auctionStartPrice: null,
      breakEven: null,
      recommendedPlatform: "wait",
      notes: ["Not enough usable comps to publish selling guidance."],
      assumptions: { feePct, shippingCost },
    };
  }

  // Build a price band. Prefer the model's quick/premium lanes (which the
  // pipeline already produces from quantiles of the velocity-weighted pool)
  // and fall back to the 25th/75th percentile of the raw comp pool if a
  // lane is missing.
  const sortedPrices = params.comps
    .map((c) => c.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);
  const percentile = (p: number): number | null => {
    if (sortedPrices.length === 0) return null;
    if (sortedPrices.length === 1) return sortedPrices[0];
    const idx = Math.max(0, Math.min(sortedPrices.length - 1, Math.round((sortedPrices.length - 1) * p)));
    return sortedPrices[idx];
  };
  const low = quick ?? percentile(0.25) ?? fair * 0.85;
  const high = premium ?? percentile(0.75) ?? fair * 1.15;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // eBay BIN sticker: list ~12% above fair so best-offer haggling lands at
  // fair, and 13% fees + shipping still net the seller close to FMV.
  const ebayListing = round2(fair * 1.12 + shippingCost);
  // Floor any best-offer should clear — slightly below quick-sale price.
  const bestOfferFloor = round2(Math.min(low, fair * 0.92));
  // Auction starter: aggressive 60% of fair, drives early bidders.
  const auctionStart = round2(Math.max(0.99, fair * 0.6));
  // Gross sale price needed to net `fair` post-fees & shipping.
  const breakEven = round2((fair + shippingCost) / (1 - feePct));

  // Pick a platform. Defer to the orchestrator's recommendedMethod if it
  // already returned a real choice; otherwise infer from market speed/demand.
  const incoming = (params.recommendedMethod ?? "").toLowerCase();
  let platform: SellingGuidance["recommendedPlatform"];
  if (incoming === "auction" || incoming === "buy_it_now" || incoming === "best_offer" || incoming === "wait") {
    platform = incoming;
  } else {
    const speed = (params.marketSpeed ?? "").toLowerCase();
    const demand = (params.demand ?? "").toLowerCase();
    if (speed === "fast" && (demand === "high" || demand === "medium")) platform = "auction";
    else if (demand === "high") platform = "buy_it_now";
    else if (demand === "low" || speed === "slow") platform = "best_offer";
    else platform = "buy_it_now";
  }

  const notes: string[] = [];
  notes.push(
    platform === "auction"
      ? `Start auction at $${auctionStart} to drive bidders; expect a clear in the $${round2(low)}–$${round2(high)} band.`
      : platform === "best_offer"
      ? `List BIN at $${ebayListing} with Best Offer enabled; auto-decline below $${bestOfferFloor}.`
      : platform === "wait"
      ? "Hold — market doesn't support a confident sale right now."
      : `List BIN at $${ebayListing}; accept best offers above $${bestOfferFloor}.`,
  );
  if (breakEven > ebayListing) {
    notes.push(
      `Heads up: at ${Math.round(feePct * 100)}% fees + $${shippingCost} shipping you'd need $${breakEven} gross to net the $${round2(fair)} fair price.`,
    );
  }

  return {
    sellRange: { low: round2(low), high: round2(high) },
    quickSale: quick != null ? round2(quick) : round2(low),
    fair: round2(fair),
    ebayListingPrice: ebayListing,
    bestOfferFloor,
    auctionStartPrice: auctionStart,
    breakEven,
    recommendedPlatform: platform,
    notes,
    assumptions: { feePct, shippingCost },
  };
}

async function fetchBroaderTrend(
  card: NonNullable<FetchedComps["card"]>,
  grade: string,
  exactComps: RawComp[],
): Promise<BroaderTrend> {
  const RECENT_DAYS = 14;
  const OLDER_DAYS = 45; // 15..45-day window
  const SIBLING_LIMIT = 8;
  const SAMPLES_PER_SIBLING = 10;

  const blankOut = (basedOn: BroaderTrend["basedOn"]): BroaderTrend => ({
    impliedTrendPct: 0,
    direction: "flat",
    recentMedian: null,
    olderMedian: null,
    recentCount: 0,
    olderCount: 0,
    similarCardsScanned: 0,
    totalSamples: 0,
    windowRecentDays: RECENT_DAYS,
    windowOlderDays: OLDER_DAYS,
    basedOn,
  });

  if (!process.env.CARD_HEDGE_API_KEY) return blankOut("insufficient");

  const player = (card.player ?? "").trim();
  const set = (card.set ?? "").trim();
  const year = card.year != null ? String(card.year).trim() : "";
  if (!player || !set) return blankOut("insufficient");

  // Find sibling cards: same player + year + set, any variant.
  let siblings: CardHedgeCard[] = [];
  try {
    siblings = await searchCards(`${year} ${set} ${player}`.trim(), 20);
  } catch {
    siblings = [];
  }

  // Filter to same player + set, drop the exact card_id (already in exactComps),
  // cap to SIBLING_LIMIT to bound Card Hedge API cost (cached 12h after first hit).
  const playerLc = player.toLowerCase();
  const setLc = set.toLowerCase();
  const yearLc = year.toLowerCase();
  const siblingIds = siblings
    .filter((s) => (s.player ?? "").toLowerCase() === playerLc)
    .filter((s) => (s.set ?? "").toLowerCase() === setLc)
    .filter((s) => !yearLc || String(s.year ?? "").toLowerCase() === yearLc)
    .filter((s) => s.card_id !== card.card_id)
    .slice(0, SIBLING_LIMIT)
    .map((s) => s.card_id);

  // Pull sales for each sibling in parallel (each call cached individually).
  const siblingSales = await Promise.all(
    siblingIds.map(async (id) => {
      try {
        return await getCardSales(id, grade, SAMPLES_PER_SIBLING);
      } catch {
        return [];
      }
    }),
  );

  // Pool: sibling sales + exact comps (treat exact as part of the trend pool too).
  type DatedPrice = { price: number; ts: number };
  const pool: DatedPrice[] = [];
  for (const arr of siblingSales) {
    for (const s of arr) {
      const ts = Date.parse(s.date || "");
      if (Number.isFinite(ts) && s.price > 0) pool.push({ price: s.price, ts });
    }
  }
  for (const c of exactComps) {
    const ts = Date.parse(c.soldDate || "");
    if (Number.isFinite(ts) && c.price > 0) pool.push({ price: c.price, ts });
  }

  if (pool.length === 0) return blankOut("insufficient");

  const now = Date.now();
  const recentCutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
  const olderCutoff = now - OLDER_DAYS * 24 * 3600 * 1000;

  const recent = pool.filter((p) => p.ts >= recentCutoff);
  const older = pool.filter((p) => p.ts < recentCutoff && p.ts >= olderCutoff);

  const recentMed = computeWeightedMedian(recent.map((p) => ({ price: p.price, date: p.ts })));
  const olderMed = computeWeightedMedian(older.map((p) => ({ price: p.price, date: p.ts })));

  // Need at least 2 in each window to call a trend; otherwise mark insufficient.
  if (recent.length < 2 || older.length < 2 || !recentMed || !olderMed) {
    return {
      ...blankOut(siblingIds.length > 0 ? "broader" : "exact"),
      recentMedian: recentMed,
      olderMedian: olderMed,
      recentCount: recent.length,
      olderCount: older.length,
      similarCardsScanned: siblingIds.length,
      totalSamples: pool.length,
    };
  }

  const pct = ((recentMed - olderMed) / olderMed) * 100;
  // Cap absurd swings (small-sample noise) to ±60%.
  const clamped = Math.max(-60, Math.min(60, pct));
  const direction: BroaderTrend["direction"] =
    clamped > 3 ? "up" : clamped < -3 ? "down" : "flat";

  return {
    impliedTrendPct: Math.round(clamped * 10) / 10,
    direction,
    recentMedian: Math.round(recentMed * 100) / 100,
    olderMedian: Math.round(olderMed * 100) / 100,
    recentCount: recent.length,
    olderCount: older.length,
    similarCardsScanned: siblingIds.length,
    totalSamples: pool.length,
    windowRecentDays: RECENT_DAYS,
    windowOlderDays: OLDER_DAYS,
    basedOn: siblingIds.length > 0 ? "broader" : "exact",
  };
}

async function fetchComps(
  query: string,
  grade: string = "Raw",
  pinnedCardId?: string
): Promise<FetchedComps> {
  if (!process.env.CARD_HEDGE_API_KEY) {
    console.warn("[compiq.fetchComps] CARD_HEDGE_API_KEY missing — returning []");
    return { comps: [], card: null, variantWarning: [], aiCategory: null };
  }

  // ----- Card-Ladder-style pinned card_id path --------------------------
  // When the iOS client picked a specific Card Hedge card from the search
  // list, skip identity resolution entirely and pull sales directly.
  if (pinnedCardId) {
    const sales = await getCardSales(pinnedCardId, grade, 25);
    // Pull set/player/variant for display by looking up via search (best effort).
    let identityCard: any = null;
    try {
      const hits = await searchCards(query || pinnedCardId, 20);
      identityCard = hits.find((h) => h.card_id === pinnedCardId) ?? null;
    } catch {
      identityCard = null;
    }
    const identity = identityCard
      ? {
          card_id: identityCard.card_id,
          title: identityCard.title ?? identityCard.name ?? null,
          player: identityCard.player ?? null,
          set: identityCard.set ?? null,
          year: identityCard.year ?? null,
          number: identityCard.number ?? null,
          variant: identityCard.variant ?? null,
        }
      : {
          card_id: pinnedCardId,
          title: null,
          player: null,
          set: null,
          year: null,
          number: null,
          variant: null,
        };

    if (sales.length === 0) {
      console.warn(`[compiq.fetchComps] pinned card_id=${pinnedCardId} returned 0 comps`);
      return { comps: [], card: identity, variantWarning: [], aiCategory: null };
    }

    const mapped: RawComp[] = sales
      .map((s) => ({
        price: s.price,
        title: s.title || [identity.year, identity.set, identity.player, identity.number, identity.variant].filter(Boolean).join(" "),
        soldDate: s.date ?? "",
      }))
      .filter((c) => c.price > 0);

    console.log(`[compiq.fetchComps] pinned card_id=${pinnedCardId} comps=${mapped.length}`);
    return { comps: mapped, card: identity, variantWarning: [], aiCategory: null };
  }

  const { card, sales, variantWarning, aiCategory } = await findCompsByQuery(query, { grade, limit: 25 });

  if (!card) {
    console.warn(`[compiq.fetchComps] Card Hedge found no matching card for "${query}"`);
    return { comps: [], card: null, variantWarning: [], aiCategory };
  }

  const identity = {
    card_id: card.card_id,
    title: card.title ?? card.name ?? null,
    player: card.player ?? null,
    set: card.set ?? null,
    year: card.year ?? null,
    number: card.number ?? null,
    variant: card.variant ?? null,
  };

  if (sales.length === 0) {
    console.warn(
      `[compiq.fetchComps] Card Hedge returned 0 comps for card_id=${card.card_id} query="${query}" grade=${grade}`
    );
    return { comps: [], card: identity, variantWarning, aiCategory };
  }

  const mapped: RawComp[] = sales
    .map((s) => ({
      price: s.price,
      title: s.title || [card.year, card.set, card.player, card.number, card.variant].filter(Boolean).join(" "),
      soldDate: s.date ?? "",
    }))
    .filter((c) => c.price > 0);

  console.log(
    `[compiq.fetchComps] Card Hedge: query="${query}" card_id=${card.card_id} comps=${mapped.length}`
  );
  return { comps: mapped, card: identity, variantWarning, aiCategory };
}

/**
 * Apply the CompIQ "21-day window" rule: discard sales older than 21 days
 * unless that would leave fewer than 3 comps (thin market — keep everything).
 */
function applyRecencyFilter(pool: RawComp[]): RawComp[] {
  const cutoff = Date.now() - 21 * 24 * 3600 * 1000;
  const fresh = pool.filter((c) => {
    if (!c.soldDate) return false;
    const ts = Date.parse(c.soldDate);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  return fresh.length >= 3 ? fresh : pool;
}

/**
 * Parse a Card Hedge grade string out of the user's free-text query.
 * Recognizes "PSA 10", "BGS 9.5", "SGC 10", "CGC 10", "Raw"/"ungraded".
 * Returns null when nothing is detected so caller falls back to "Raw".
 */
function parseGradeFromQuery(query: string): string | null {
  const q = query.toLowerCase();
  if (/\b(raw|ungraded)\b/.test(q)) return "Raw";
  const m = q.match(/\b(psa|bgs|sgc|cgc)\s*([0-9]+(?:\.5)?)\b/);
  if (m) {
    const co = m[1].toUpperCase();
    const val = m[2];
    return `${co} ${val}`;
  }
  return null;
}

/**
 * Comp-volume confidence ceiling per the CompIQ pricing rules:
 *   liquid    (≥10) → 95
 *   moderate  (5–9) → 80
 *   thin      (3–4) → 65
 *   very_thin (<3)  → 45
 * Halved further to 55 when variance exceeds 40%.
 */
function calibrateConfidence(rawConfidencePct: number, comps: { price: number }[]): number {
  const n = comps.length;
  let ceiling: number;
  if (n >= 10) ceiling = 95;
  else if (n >= 5) ceiling = 80;
  else if (n >= 3) ceiling = 65;
  else ceiling = 45;

  if (n >= 2) {
    const prices = comps.map((c) => c.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (mean > 0) {
      const std = Math.sqrt(prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length);
      if (std / mean > 0.4) ceiling = Math.min(ceiling, 55);
    }
  }

  return Math.min(rawConfidencePct, ceiling);
}

// ---------------------------------------------------------------------------
// Buy Window Score (1–10) — "Is now a good time to buy this card?"
// ---------------------------------------------------------------------------

export interface BuyWindowResult {
  score: number;          // 1..10
  label: string;          // "Strong Buy Window" etc.
  reasons: string[];      // 2–3 plain-English drivers
}

function computeBuyWindowScore(params: {
  trendDirection: "up" | "down" | "flat";
  trendPct: number;
  recentCount: number;
  olderCount: number;
  basedOn: BroaderTrend["basedOn"];
  signalMultiplier?: number;
  month: number;          // 1..12
  printRun?: number;      // e.g. 25, 99, 150
  grade?: string;
}): BuyWindowResult {
  let base = 5;

  // Trend direction adjustment
  if (params.trendDirection === "up" && params.trendPct >= 15) base += 2;
  else if (params.trendDirection === "up" && params.trendPct >= 5) base += 1;
  else if (params.trendDirection === "down" && params.trendPct <= -15) base -= 2;
  else if (params.trendDirection === "down" && params.trendPct <= -5) base -= 1;

  // Market depth adjustment
  const totalSales = params.recentCount + params.olderCount;
  if (totalSales >= 20) base += 1;
  else if (totalSales <= 3) base -= 1;

  // Signal multiplier adjustment
  if (typeof params.signalMultiplier === "number") {
    if (params.signalMultiplier >= 1.2) base += 1;
    else if (params.signalMultiplier <= 0.85) base -= 1;
  }

  // Seasonal adjustment (baseball calendar)
  const peakMonths = [3, 4, 7, 10];
  const offMonths = [11, 12, 1];
  if (peakMonths.includes(params.month)) base += 1;
  else if (offMonths.includes(params.month)) base -= 1;

  // Scarcity adjustment
  if (params.printRun && params.printRun <= 25) base += 1;
  if (params.printRun && params.printRun <= 10) base += 1;

  const score = Math.max(1, Math.min(10, base));

  const label =
    score >= 9 ? "Strong Buy Window" :
    score >= 7 ? "Good Time to Buy" :
    score >= 5 ? "Fair Buy Window" :
    score >= 3 ? "Weak Buy Window" :
    "Poor Buy Window";

  const reasons: string[] = [];
  if (params.trendDirection === "up" && params.trendPct >= 5) {
    reasons.push(`Price trending up ${params.trendPct.toFixed(0)}%`);
  } else if (params.trendDirection === "down" && params.trendPct <= -5) {
    reasons.push("Price falling — potential buy dip");
  }
  if (totalSales < 5) reasons.push("Thin market — price less reliable");
  else if (totalSales >= 20) reasons.push("Liquid market — reliable signal");
  if (peakMonths.includes(params.month)) reasons.push("Peak baseball season demand");
  else if (offMonths.includes(params.month)) reasons.push("Off-season — lower demand");
  if (params.printRun && params.printRun <= 25) {
    reasons.push(`Scarce card — only /${params.printRun} exist`);
  }
  if (typeof params.signalMultiplier === "number" && params.signalMultiplier >= 1.2) {
    reasons.push("Live demand signals running hot");
  } else if (typeof params.signalMultiplier === "number" && params.signalMultiplier <= 0.85) {
    reasons.push("Live demand signals cooling");
  }
  if (params.basedOn === "insufficient") {
    reasons.push("Limited comp history — confidence reduced");
  }

  return { score, label, reasons: reasons.slice(0, 3) };
}

// Extract a print run integer from a parallel string like "Blue /99" or "Red Refractor /25".
function parsePrintRun(parallel?: string | null): number | undefined {
  if (!parallel) return undefined;
  const m = String(parallel).match(/\/\s*(\d{1,5})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Confidence Interval (range around the predicted price)
// ---------------------------------------------------------------------------

export interface ConfidenceIntervalResult {
  low: number;
  high: number;
  width: "narrow" | "moderate" | "wide";
  explanation: string;
}

function computeConfidenceInterval(params: {
  predictedPrice: number;
  recentCount: number;
  olderCount: number;
  basedOn: BroaderTrend["basedOn"];
  trendPct: number;
}): ConfidenceIntervalResult | null {
  if (!Number.isFinite(params.predictedPrice) || params.predictedPrice <= 0) return null;
  const totalSamples = params.recentCount + params.olderCount;

  let spreadPct: number;
  if (totalSamples >= 20 && params.basedOn === "exact") {
    spreadPct = 0.08;
  } else if (totalSamples >= 10) {
    spreadPct = 0.15;
  } else if (totalSamples >= 5) {
    spreadPct = 0.22;
  } else if (totalSamples >= 2) {
    spreadPct = 0.35;
  } else {
    spreadPct = 0.5;
  }

  if (Math.abs(params.trendPct) >= 20) spreadPct *= 1.3;

  const low = Math.round(params.predictedPrice * (1 - spreadPct));
  const high = Math.round(params.predictedPrice * (1 + spreadPct));
  const width: ConfidenceIntervalResult["width"] =
    spreadPct <= 0.1 ? "narrow" : spreadPct <= 0.25 ? "moderate" : "wide";

  const explanation =
    width === "narrow" ? `Based on ${totalSamples} recent sales — high confidence`
    : width === "moderate" ? `Based on ${totalSamples} sales — moderate confidence`
    : `Limited sales data (${totalSamples} found) — wide estimate range`;

  return { low, high, width, explanation };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function computeEstimate(body: CompIQEstimateRequest): Promise<Record<string, unknown>> {

  // Detect "auto" / "autograph" inside the parallel string (e.g. "Blue
  // Refractor Auto") and treat it as if isAuto were explicitly set. Without
  // this, the parallel filter would happily pool non-auto base refractors
  // alongside the autograph variant and collapse the FMV.
  const autoTokenRegex = /\b(auto|autograph|autographed)\b/i;
  const parallelHasAutoToken = body.parallel ? autoTokenRegex.test(body.parallel) : false;
  const effectiveIsAuto = body.isAuto === true || parallelHasAutoToken;

  // Strip auto-tokens out of the parallel before normalization so the
  // remaining color/serial words survive (e.g. "Blue Refractor Auto" →
  // "Blue Refractor"). isAuto is now carried separately in subject + title.
  const parallelForNorm = body.parallel
    ? body.parallel.replace(autoTokenRegex, " ").replace(/\s+/g, " ").trim() || undefined
    : undefined;

  const normalizedParallel = normalizeParallel(parallelForNorm);
  const normalizedGradeCompany = normalizeGradeCompany(body.gradeCompany);

  const cardTitle = [
    body.playerName,
    body.cardYear,
    body.product,
    normalizedParallel ?? parallelForNorm ?? body.parallel,
    normalizedGradeCompany ? `${normalizedGradeCompany} ${body.gradeValue}` : undefined,
    effectiveIsAuto ? "Auto" : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  // Build subject for the pipeline
  const subject = {
    playerName: body.playerName,
    cardYear: body.cardYear,
    product: body.product,
    parallel: normalizedParallel,
    gradeCompany: normalizedGradeCompany,
    gradeValue: body.gradeValue,
    isAuto: effectiveIsAuto,
  };

  // Fetch live comps from Card Hedge AI (primary sold-data source).
  // Card Hedge expects a slab grade string ("PSA 10", "BGS 9.5", ...) or "Raw"
  // for ungraded. Resolution order:
  //   1. Explicit gradeCompany + gradeValue on the request body
  //   2. Grade tokens parsed out of the free-text playerName/query
  //   3. Default "Raw"
  const explicitGrade =
    normalizedGradeCompany && body.gradeValue
      ? `${normalizedGradeCompany} ${body.gradeValue}`
      : null;
  const inferredGrade = explicitGrade ? null : parseGradeFromQuery(cardTitle);
  const cardHedgeGrade = explicitGrade ?? inferredGrade ?? "Raw";
  let fetched = await fetchComps(cardTitle, cardHedgeGrade, body.cardHedgeCardId);

  // ── Sport-scope guard ────────────────────────────────────────────────────
  // CompIQ currently supports baseball only (issue #7). If Card Hedge's AI
  // confidently identified this card as a different sport, short-circuit
  // BEFORE any pricing math runs. We return a stub with source=
  // "unsupported_sport" rather than silently mis-pricing (e.g. case-15:
  // "1986 Fleer Michael Jordan PSA 8" was pricing as a 1991 UD Baseball
  // novelty at ~$46 because identifyCard returned the Basketball Jordan at
  // confidence 0.96). Multi-sport is future scope — when CompIQ adds a
  // sport, expand SUPPORTED_SPORTS rather than removing this gate.
  //
  // Note: this guard fires only when `aiCategory` is populated, which is
  // only the free-text query path (findCompsByQuery → identifyCard). The
  // pinned-card-id path never sets aiCategory because category is not
  // resolved there; that path is gated upstream by the iOS picker, which
  // is fed by /search-list → searchCards (Baseball-locked).
  const SUPPORTED_SPORTS = new Set(["baseball"]);
  const detectedCategory = fetched.aiCategory;
  if (detectedCategory && !SUPPORTED_SPORTS.has(detectedCategory.toLowerCase())) {
    console.log(
      `[compiq.computeEstimate] unsupported-sport short-circuit: query="${cardTitle}" detected="${detectedCategory}"`
    );
    const sportLower = detectedCategory.toLowerCase();
    const unsupportedReason = `CompIQ currently supports baseball cards only. This appears to be a ${sportLower} card.`;
    return {
      source: "unsupported_sport",
      unsupportedSportReason: unsupportedReason,
      detectedSport: detectedCategory,
      cardIdentity: fetched.card
        ? {
            card_id: fetched.card.card_id,
            title: fetched.card.title ?? null,
            player: fetched.card.player ?? null,
            set: fetched.card.set ?? null,
            year: fetched.card.year ?? null,
            number: fetched.card.number ?? null,
            variant: fetched.card.variant ?? null,
          }
        : null,
      fairMarketValue: 0,
      quickSaleValue: 0,
      premiumValue: 0,
      compsUsed: 0,
      compsAvailable: 0,
      recentComps: [],
      variantWarning: [],
      confidence: { pricingConfidence: 0 },
      verdict: `Unsupported sport (${detectedCategory}). CompIQ currently prices baseball cards only.`,
      gradeUsed: cardHedgeGrade,
      marketDNA: { trend: "flat", speed: "Normal" },
    } as Record<string, unknown>;
  }

  // ── Player-identity guard ────────────────────────────────────────────────
  // Card Hedge `/cards/card-search` is a fuzzy match — a query for "Cooper
  // Bonemer" can resolve to "Cooper Pratt" if Bonemer isn't in the catalog.
  // Verify that the user's surname(s) appear in the resolved card's player
  // or title. If not, discard the entire comp pool so downstream paths fall
  // through to the eBay-sold-listing fallback (which uses the literal query).
  //
  // Skip the guard on the pinned-card-id path: comps were fetched
  // authoritatively by Card Hedge `card_id` (no fuzzy-match ambiguity to
  // defend against), and the guard's haystack relies on identity metadata
  // that the pinned path can't always populate (the card_id may not appear
  // in the top-20 `searchCards` hits used for the cosmetic identity lookup),
  // which would otherwise wipe valid comps.
  if (fetched.card && body.playerName && !body.cardHedgeCardId) {
    const wanted = body.playerName
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z]/g, ""))
      .filter((t) => t.length >= 4); // ignore initials / short tokens
    const haystack = (
      (fetched.card.player ?? "") +
      " " +
      (fetched.card.title ?? "")
    ).toLowerCase();
    const missingSurnames = wanted.filter((t) => !haystack.includes(t));
    // ANY missing surname token disqualifies — CH "Cooper Pratt" must NOT
    // match a user query for "Cooper Bonemer" just because the first names
    // collide.
    if (wanted.length > 0 && missingSurnames.length > 0) {
      console.warn(
        `[compiq.computeEstimate] CH identity mismatch: query player="${body.playerName}" CH player="${fetched.card.player}" — discarding ${fetched.comps.length} wrong-player comps`
      );
      fetched = {
        comps: [],
        card: null,
        variantWarning: [...(fetched.variantWarning ?? []), "player_mismatch"],
        aiCategory: fetched.aiCategory,
      };
    }
  }

  const recencyFilteredComps = applyRecencyFilter(fetched.comps);

  // ── Variant match filter (Pricing Accuracy — CardQueryParser wiring) ─────
  // Reject comps that don't match the requested variant BEFORE any quality
  // or anchor math runs. This catches the "Sky Blue base" comps that Card
  // Hedge returns when asked for "Blue Auto" — and prevents them from being
  // averaged into the FMV.
  const { isCompVariantMatch, parseCardQuery: parseCardQueryFn } = await import("./cardQueryParser.js");
  const parsedForGuard = parseCardQueryFn(cardTitle);
  // Override parsed flags with the explicit body fields when present so the
  // structured /estimate path (which doesn't run the route-level parser) still
  // gets correct variant info.
  if (effectiveIsAuto) parsedForGuard.isAuto = true;
  if (normalizedParallel) parsedForGuard.parallel = normalizedParallel;
  if (body.cardYear) parsedForGuard.year = body.cardYear;

  const variantFiltered: typeof recencyFilteredComps = [];
  const variantExclusionReasons: Record<string, number> = {};
  for (const c of recencyFilteredComps) {
    const m = isCompVariantMatch(c.title, parsedForGuard);
    if (m.match) {
      variantFiltered.push(c);
    } else {
      const key = m.reason.split(":")[0];
      variantExclusionReasons[key] = (variantExclusionReasons[key] ?? 0) + 1;
    }
  }
  const variantExcludedCount = recencyFilteredComps.length - variantFiltered.length;
  if (variantExcludedCount > 0) {
    console.log(
      `[compiq.computeEstimate] variant filter excluded ${variantExcludedCount}/${recencyFilteredComps.length} comps: ${JSON.stringify(variantExclusionReasons)}`
    );
  }
  // If the variant filter dropped EVERYTHING and the user asked for a
  // specific autograph or specific parallel, short-circuit to insufficient
  // rather than ship the wrong card's FMV.
  const everythingFilteredOut =
    recencyFilteredComps.length > 0 && variantFiltered.length === 0 &&
    (parsedForGuard.isAuto || Boolean(parsedForGuard.parallel));
  // Substitute the variant-filtered pool for downstream stages when at least
  // some comps survived. Otherwise keep the original pool — the
  // dataSufficiency / variant-mismatch guard logic below handles the empty
  // case explicitly.
  const compsAfterVariantFilter = variantFiltered.length > 0 ? variantFiltered : recencyFilteredComps;

  // ── Variant-mismatch guard ───────────────────────────────────────────────
  // When the request asked for an autograph (or a /serial-numbered parallel)
  // and Card Hedge could not match a card_id that carries that variant token,
  // `findCompsByQuery` emits a `variantWarning` and falls back to the closest
  // base card. Rather than ship a confidently-wrong FMV from the wrong card,
  // short-circuit to insufficient-data so the iOS UI tells the user "we
  // can't price this variant yet" instead of showing a misleading price.
  const variantWarningTokens = (fetched.variantWarning ?? []).map((t) => t.toLowerCase());
  const variantMismatchCritical =
    everythingFilteredOut ||
    (effectiveIsAuto && variantWarningTokens.some((t) => /(auto|autograph|signed|signature)/.test(t))) ||
    variantWarningTokens.some((t) => /^\/\d/.test(t)); // missing /serial token
  if (variantMismatchCritical) {
    const guardReasons: string[] = [];
    if (variantWarningTokens.length > 0) guardReasons.push(...variantWarningTokens);
    if (everythingFilteredOut) {
      const detail = Object.entries(variantExclusionReasons)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ");
      guardReasons.push(`all ${recencyFilteredComps.length} fetched comps rejected by variant filter (${detail})`);
    }
    const missing = guardReasons.join("; ") || "variant tokens";
    console.warn(
      `[compiq.computeEstimate] variant-mismatch guard tripped: query="${cardTitle}" reason="${missing}" — attempting neighbor synthesis`
    );

    // Capture last neighbor-synthesis attempt for debug visibility in the
    // null-FMV variant-mismatch response. iOS doesn't surface this — it's
    // a console/API debugging aid only.
    let neighborDebug: any = null;
    if (process.env.COMPIQ_NEIGHBOR_SYNTHESIS !== "false") {
      try {
        const { synthesizeFromNeighbors } = await import("./neighborSynthesis.js");
        // Augment Card Hedge neighbor pool with eBay sold-listing fallback
        // when CH is thin. This is the primary fix for /150-print parallels
        // and other low-volume cards where CH has 0 backing comps.
        const { fetchEbayNeighborComps } = await import("./ebayFallback.js");
        const ebayComps =
          fetched.comps.length < 5 ? await fetchEbayNeighborComps(cardTitle, { daysBack: 60 }) : [];
        const combinedComps = [...fetched.comps, ...ebayComps];
        if (combinedComps.length < 2) {
          throw new Error(`insufficient_neighbor_pool comps=${combinedComps.length}`);
        }
        const neighborResult = synthesizeFromNeighbors(parsedForGuard, combinedComps, { trendWindowDays: 60 });
        if (neighborResult.syntheticFmv != null && neighborResult.neighborsUsed >= 2) {
          const fmv = neighborResult.syntheticFmv;
          console.log(
            `[compiq.computeEstimate] neighbor-synthesis success: fmv=$${fmv.toFixed(2)} from ${neighborResult.neighborsUsed} neighbors (steps=${neighborResult.stepsRelaxedMax}, cap=${neighborResult.confidenceCap})`
          );
          return {
            cardTitle,
            verdict: `Indicative price ($${fmv.toFixed(2)}) synthesized from ${neighborResult.neighborsUsed} neighbor sales — no direct comps yet for this exact variant.`,
            action: "Hold",
            dealScore: null,
            quickSaleValue: fmv * 0.88,
            fairMarketValue: fmv,
            premiumValue: fmv * 1.15,
            explanation: [
              `No direct comps for ${effectiveIsAuto ? "this autograph " : ""}variant (missing: ${missing}).`,
              `Built indicative FMV from ${neighborResult.neighborsUsed} of ${neighborResult.neighborsConsidered} related Card Hedge sales using parallel/grade/auto multipliers.`,
              `Confidence is capped at ${neighborResult.confidenceCap}/100 — treat this as a directional estimate, not a firm market price.`,
            ],
            marketDNA: {
              demand: "Unknown",
              speed: "Unknown",
              risk: "High",
              trend: "Flat",
              marketCondition: "Neighbor-Synthesized",
            },
            marketRegime: {
              regime: "illiquid",
              volatilityPct: 0,
              slopePctPerComp: 0,
              confidence: 0.2,
              note: "Neighbor-synthesized price — no direct comps for this variant.",
            },
            normalization: {
              parallelInput: body.parallel ?? null,
              parallelCanonical: normalizedParallel ?? null,
              gradeCompanyInput: body.gradeCompany ?? null,
              gradeCompanyCanonical: normalizedGradeCompany ?? null,
            },
            confidence: {
              pricingConfidence: neighborResult.confidenceCap,
              liquidityConfidence: 0,
              timingConfidence: 0,
            },
            exitStrategy: {
              recommendedMethod: "wait",
              expectedDaysToSell: null,
              timingRecommendation: "Hold — wait for direct comps before pricing aggressively.",
            },
            freshness: { status: "Stale" as const, lastUpdated: null },
            pricingAnalytics: null,
            estimate: null,
            compsUsed: 0,
            compsAvailable: fetched.comps.length,
            neighborsUsed: neighborResult.neighborsUsed,
            neighborSynthesis: {
              stepsRelaxedMax: neighborResult.stepsRelaxedMax,
              detail: neighborResult.detail.slice(0, 10),
              anchor: neighborResult.anchor,
              trend: neighborResult.trend,
            },
            cardIdentity: fetched.card,
            recentComps: fetched.comps
              .slice()
              .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
              .map((c) => ({ price: c.price, title: c.title, soldDate: c.soldDate, grade: formatGradeLabel(c.title) })),
            gradeUsed: cardHedgeGrade,
            source: "neighbor-synthesis",
            daysSinceNewestComp: null,
            variantWarning: fetched.variantWarning,
            compQuality: { totalComps: 0, usedComps: 0, excluded: 0, reasons: {} },
            dataSufficiency: {
              sufficient: false,
              level: "low" as const,
              message: `Neighbor-synthesized from ${neighborResult.neighborsUsed} related sales.`,
            },
            risk_flags: neighborResult.riskFlags,
          } as any;
        }
        console.log(
          `[compiq.computeEstimate] neighbor-synthesis insufficient: used=${neighborResult.neighborsUsed}/${neighborResult.neighborsConsidered} flags=${neighborResult.riskFlags.join(",")}`
        );
        neighborDebug = {
          neighborsUsed: neighborResult.neighborsUsed,
          neighborsConsidered: neighborResult.neighborsConsidered,
          riskFlags: neighborResult.riskFlags,
          syntheticFmv: neighborResult.syntheticFmv,
          stepsRelaxedMax: neighborResult.stepsRelaxedMax,
          detail: neighborResult.detail.slice(0, 5),
        };
      } catch (err) {
        console.warn(`[compiq.computeEstimate] neighbor-synthesis failed: ${(err as Error).message}`);
        neighborDebug = { error: (err as Error).message };
      }
    }

    // ── Cross-parallel sibling synthesis (variant-mismatch fallback) ────────
    // The within-card neighbor synthesis above failed. As a last resort,
    // try synthesizing a price from sibling parallels of the same player +
    // year + set (e.g. price a Blue Wave /150 from the Refractor /150 +
    // Atomic /250 + Gold /50 trend). This gives the user a directional
    // FMV plus a fresh trend instead of a blank card.
    let xpCrossParallelAnchor: any = null;
    let xpEffectiveFmv: number | null = null;
    let xpVerdict: string | null = null;
    try {
      const { fetchSiblingParallelComps } = await import("./cardhedge.client.js");
      const siblings = await fetchSiblingParallelComps({
        playerName: body.playerName ?? "",
        year: body.cardYear ?? fetched.card?.year ?? null,
        set: body.product ?? fetched.card?.set ?? null,
        excludeCardId: fetched.card?.card_id ?? null,
        grade: cardHedgeGrade,
        perSiblingLimit: 6,
        maxSiblings: 12,
      });
      if (siblings.length >= 3) {
        const { synthesizeFromNeighbors } = await import("./neighborSynthesis.js");
        const { parseCardQuery: parseFn } = await import("./cardQueryParser.js");
        const targetParsed = parseFn(cardTitle);
        if (effectiveIsAuto) targetParsed.isAuto = true;
        if (normalizedParallel) targetParsed.parallel = normalizedParallel;
        if (body.cardYear) targetParsed.year = body.cardYear;
        const synth = synthesizeFromNeighbors(
          targetParsed,
          siblings.map((s) => ({ title: s.title, price: s.price, soldDate: s.soldDate ?? undefined })),
          { trendWindowDays: 60 }
        );
        if (synth.syntheticFmv != null && synth.neighborsUsed >= 3) {
          const synthFmv = Math.round(synth.syntheticFmv * 100) / 100;
          xpCrossParallelAnchor = {
            fmv: synthFmv,
            neighborsUsed: synth.neighborsUsed,
            neighborsConsidered: synth.neighborsConsidered,
            parallelTier: (synth as any).parallelTier ?? null,
            confidenceCap: synth.confidenceCap,
            anchor: synth.anchor,
            trend: synth.trend,
            triggerReason: "variant-mismatch",
            detail: synth.detail.slice(0, 10),
            momentumAdjustedFmv: null,
            momentumPctApplied: null,
            weeksStale: null,
            effectiveWeeksApplied: null,
            momentumSource: null,
          };
          xpEffectiveFmv = synthFmv;
          xpVerdict = `Indicative price ($${synthFmv.toFixed(2)}) synthesized from ${synth.neighborsUsed} sibling-parallel sales — Card Hedge has no direct comps for this exact variant yet.`;
          console.log(
            `[compiq.computeEstimate] variant-mismatch cross-parallel synthesis: fmv=$${synthFmv} from ${synth.neighborsUsed} siblings (trend=${synth.trend?.direction})`
          );
        }
      }
    } catch (err) {
      console.warn(`[compiq.computeEstimate] variant-mismatch cross-parallel synthesis failed: ${(err as Error).message}`);
    }

    return {
      cardTitle,
      verdict: xpVerdict ?? `No comps found for this exact variant (missing: ${missing}). Card Hedge doesn't have sold data for this card yet.`,
      action: "Hold",
      dealScore: null,
      quickSaleValue: null,
      fairMarketValue: null,
      premiumValue: null,
      explanation: [
        `Requested ${effectiveIsAuto ? "autograph " : ""}variant not found in Card Hedge's sold database.`,
        `Closest match on file: ${fetched.card?.variant ?? "unknown"} (missing: ${missing}).`,
        "Will retry automatically once comps are recorded.",
      ],
      marketDNA: {
        demand: "Unknown",
        speed: "Unknown",
        risk: "High",
        trend: "Flat",
        marketCondition: "Variant Not Found",
      },
      marketRegime: {
        regime: "illiquid",
        volatilityPct: 0,
        slopePctPerComp: 0,
        confidence: 0.2,
        note: "Variant mismatch — no usable comps for the requested card.",
      },
      normalization: {
        parallelInput: body.parallel ?? null,
        parallelCanonical: normalizedParallel ?? null,
        gradeCompanyInput: body.gradeCompany ?? null,
        gradeCompanyCanonical: normalizedGradeCompany ?? null,
      },
      confidence: { pricingConfidence: 0, liquidityConfidence: 0, timingConfidence: 0 },
      exitStrategy: {
        recommendedMethod: "wait",
        expectedDaysToSell: null,
        timingRecommendation: "Wait for the variant's first comps to land in Card Hedge.",
      },
      freshness: { status: "Needs refresh" as const, lastUpdated: null },
      pricingAnalytics: null,
      estimate: null,
      // compsUsed = 0 because none of the fetched comps matched the
      // requested variant (so they can't price it). compsAvailable surfaces
      // the raw fetched count so the iOS UI can still say
      // "10 comps on file for this card — none match your variant" instead
      // of misleadingly showing 0.
      compsUsed: 0,
      compsAvailable: fetched.comps.length,
      cardIdentity: fetched.card,
      // Even though these comps didn't match the requested variant, surface
      // them so the iOS UI can show the user what Card Hedge *does* have on
      // file for this card — labeled "variant mismatch" so it's clear they
      // weren't used for pricing.
      recentComps: fetched.comps
        .slice()
        .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
        .map((c) => ({ price: c.price, title: c.title, soldDate: c.soldDate, grade: formatGradeLabel(c.title) })),
      gradeUsed: cardHedgeGrade,
      source: "variant-mismatch",
      daysSinceNewestComp: null,
      variantWarning: fetched.variantWarning,
      compQuality: { totalComps: 0, usedComps: 0, excluded: 0, reasons: {} },
      crossParallelAnchor: xpCrossParallelAnchor,
      effectiveFmv: xpEffectiveFmv,
      dataSufficiency: {
        sufficient: false,
        level: "none" as const,
        message: `Variant not found (missing: ${missing}).`,
      },
      neighborSynthesisDebug: neighborDebug,
    };
  }

  // ── Comp Quality Filter (Pricing Accuracy — Improvement 2) ──────────────
  // Strip lot/damaged/altered listings and 2.5σ price outliers BEFORE any
  // anchor/median calculation. Surface counts in the response so the iOS
  // confidence row can say "Based on 8 of 12 sales (4 removed for quality)".
  const qualityFilter = applyCompQualityFilter(compsAfterVariantFilter, {
    player: fetched.card?.player ?? body.playerName ?? null,
    year: fetched.card?.year ?? body.cardYear ?? null,
    set: fetched.card?.set ?? body.product ?? null,
  });
  const rawComps = qualityFilter.filtered;
  const compQualityInfo = {
    totalComps: recencyFilteredComps.length,
    usedComps: qualityFilter.filtered.length,
    excluded: qualityFilter.excluded + variantExcludedCount,
    reasons: {
      ...qualityFilter.reasons,
      ...(variantExcludedCount > 0 ? { variant_mismatch: variantExcludedCount } : {}),
    },
  };
  const cardIdentity = fetched.card;

  // --- Thin-data short-circuit ----------------------------------------------
  // CompIQ Anti-Yesterday Rule + "never anchor to a single stale sale".
  // Policy (relaxed for rare autographs / numbered parallels which sell less
  // often than base cards):
  //   - 0 comps              → insufficient (always)
  //   - 1 comp, <=14 days    → allow (priced with thinMarket flag downstream)
  //   - 1 comp, >14 days     → insufficient
  //   - 2 comps, newest <=180 days → allow (flag stale)
  //   - 2 comps, newest >180 days  → insufficient
  //   - 3+ comps, newest <=365 days → allow (flag stale if >60d)
  //   - 3+ comps, newest >365 days  → insufficient
  // Rationale: a low-pop prospect auto may only print 2-4 sales/year; refusing
  // to price it because the most recent sale was 90 days ago is worse than
  // returning a confidence-capped estimate with a `stale_comps` risk flag.
  const newestTs = fetched.comps
    .map((c) => Date.parse(c.soldDate || ""))
    .filter((t) => Number.isFinite(t))
    .reduce((a, b) => Math.max(a, b), 0);
  const daysSinceNewest = newestTs > 0 ? Math.floor((Date.now() - newestTs) / (24 * 3600 * 1000)) : null;

  const compCount = fetched.comps.length;
  const insufficient =
    compCount === 0 ||
    (compCount === 1 && (daysSinceNewest == null || daysSinceNewest > 14)) ||
    (compCount === 2 && (daysSinceNewest == null || daysSinceNewest > 180)) ||
    (compCount >= 3 && (daysSinceNewest == null || daysSinceNewest > 365));

  if (insufficient) {
    const ageNote =
      daysSinceNewest != null
        ? `last comp was ${daysSinceNewest} days ago`
        : "no comps on file";
    const verdict = `Insufficient recent comps — ${ageNote}. Refine the query or wait for fresh sales.`;
    console.warn(
      `[compiq.computeEstimate] thin-data short-circuit: comps=${fetched.comps.length} daysSinceNewest=${daysSinceNewest} query="${cardTitle}"`
    );

    // ── Neighbor-Comp Synthesis (Phase 1) — stale/thin direct comps path ─
    // The card has SOME comps on file but they're too few or too old to
    // price directly. Try synthesizing from them with a low confidence cap
    // so the iOS UI gets an indicative number instead of an empty screen.
    if (process.env.COMPIQ_NEIGHBOR_SYNTHESIS !== "false") {
      try {
        const { synthesizeFromNeighbors } = await import("./neighborSynthesis.js");
        // Augment thin/stale CH comp pool with eBay sold listings.
        const { fetchEbayNeighborComps } = await import("./ebayFallback.js");
        const ebayComps =
          fetched.comps.length < 5 ? await fetchEbayNeighborComps(cardTitle, { daysBack: 60 }) : [];
        const combinedComps = [...fetched.comps, ...ebayComps];
        if (combinedComps.length < 2) {
          throw new Error(`insufficient_neighbor_pool comps=${combinedComps.length}`);
        }
        const neighborResult = synthesizeFromNeighbors(parsedForGuard, combinedComps, { trendWindowDays: 60 });
        if (neighborResult.syntheticFmv != null && neighborResult.neighborsUsed >= 2) {
          const fmv = neighborResult.syntheticFmv;
          // Stale-data extra penalty on top of the cap: 1 step further when
          // newest comp >180d, 2 steps when >365d. Floor at 15.
          let stalePenalty = 1.0;
          if (daysSinceNewest != null && daysSinceNewest > 365) stalePenalty = 0.64;
          else if (daysSinceNewest != null && daysSinceNewest > 180) stalePenalty = 0.8;
          const adjustedCap = Math.max(15, Math.round(neighborResult.confidenceCap * stalePenalty));
          console.log(
            `[compiq.computeEstimate] neighbor-synthesis (stale-path) success: fmv=$${fmv.toFixed(2)} from ${neighborResult.neighborsUsed} neighbors steps=${neighborResult.stepsRelaxedMax} daysSinceNewest=${daysSinceNewest} cap=${adjustedCap}`
          );
          return {
            cardTitle,
            verdict: `Indicative price ($${fmv.toFixed(2)}) synthesized from ${neighborResult.neighborsUsed} ${ageNote}. Confidence ${adjustedCap}/100.`,
            action: "Hold",
            dealScore: null,
            quickSaleValue: fmv * 0.88,
            fairMarketValue: fmv,
            premiumValue: fmv * 1.15,
            explanation: [
              `Direct comps are thin (${fetched.comps.length} on file, ${ageNote}).`,
              `Built indicative FMV from ${neighborResult.neighborsUsed} synthesized sales using parallel/grade/auto multipliers.`,
              `Confidence is capped at ${adjustedCap}/100 — treat as directional, not firm.`,
            ],
            marketDNA: {
              demand: "Unknown",
              speed: "Unknown",
              risk: "High",
              trend: "Flat",
              marketCondition: "Neighbor-Synthesized (Stale Comps)",
            },
            marketRegime: {
              regime: "illiquid",
              volatilityPct: 0,
              slopePctPerComp: 0,
              confidence: 0.2,
              note: "Neighbor-synthesized price — direct comps too thin or stale.",
            },
            normalization: {
              parallelInput: body.parallel ?? null,
              parallelCanonical: normalizedParallel ?? null,
              gradeCompanyInput: body.gradeCompany ?? null,
              gradeCompanyCanonical: normalizedGradeCompany ?? null,
            },
            confidence: {
              pricingConfidence: adjustedCap,
              liquidityConfidence: 0,
              timingConfidence: 0,
            },
            exitStrategy: {
              recommendedMethod: "wait",
              expectedDaysToSell: null,
              timingRecommendation: "Hold — wait for fresh direct comps.",
            },
            freshness: { status: "Stale" as const, lastUpdated: null },
            pricingAnalytics: null,
            estimate: null,
            compsUsed: fetched.comps.length,
            compsAvailable: fetched.comps.length,
            neighborsUsed: neighborResult.neighborsUsed,
            neighborSynthesis: {
              stepsRelaxedMax: neighborResult.stepsRelaxedMax,
              detail: neighborResult.detail.slice(0, 10),
              anchor: neighborResult.anchor,
              trend: neighborResult.trend,
            },
            cardIdentity,
            recentComps: fetched.comps
              .slice()
              .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
              .map((c) => ({ price: c.price, title: c.title, soldDate: c.soldDate, grade: formatGradeLabel(c.title) })),
            gradeUsed: cardHedgeGrade,
            source: "neighbor-synthesis",
            daysSinceNewestComp: daysSinceNewest,
            variantWarning: fetched.variantWarning,
            compQuality: { totalComps: fetched.comps.length, usedComps: 0, excluded: 0, reasons: {} },
            dataSufficiency: {
              sufficient: false,
              level: "low" as const,
              message: `Neighbor-synthesized from ${neighborResult.neighborsUsed} stale/thin sales.`,
            },
            risk_flags: [...neighborResult.riskFlags, "stale_comps"],
          } as any;
        }
        console.log(
          `[compiq.computeEstimate] neighbor-synthesis (stale-path) insufficient: used=${neighborResult.neighborsUsed}/${neighborResult.neighborsConsidered}`
        );
      } catch (err) {
        console.warn(`[compiq.computeEstimate] neighbor-synthesis (stale-path) failed: ${(err as Error).message}`);
      }
    }

    // ── Cross-parallel synthesis (no-direct-comps path) ────────────────────
    // No live comps for this card at all (or all extremely stale). Fall back
    // to sibling-parallel comps of the same player+year+set so we can still
    // give the user a defensible price + trend signal instead of "$null".
    let noCompCrossParallelAnchor: any = null;
    let noCompEffectiveFmv: number | null = null;
    try {
      const { fetchSiblingParallelComps } = await import("./cardhedge.client.js");
      const siblings = await fetchSiblingParallelComps({
        playerName: body.playerName ?? "",
        year: body.cardYear ?? cardIdentity?.year ?? null,
        set: body.product ?? cardIdentity?.set ?? null,
        excludeCardId: cardIdentity?.card_id ?? null,
        grade: cardHedgeGrade,
        perSiblingLimit: 6,
        maxSiblings: 12,
      });
      if (siblings.length >= 3) {
        const { synthesizeFromNeighbors } = await import("./neighborSynthesis.js");
        const { parseCardQuery: parseFn } = await import("./cardQueryParser.js");
        const targetParsed = parseFn(cardTitle);
        if (effectiveIsAuto) targetParsed.isAuto = true;
        if (normalizedParallel) targetParsed.parallel = normalizedParallel;
        if (body.cardYear) targetParsed.year = body.cardYear;
        const synth = synthesizeFromNeighbors(
          targetParsed,
          siblings.map((s) => ({ title: s.title, price: s.price, soldDate: s.soldDate ?? undefined })),
          { trendWindowDays: 60 }
        );
        if (synth.syntheticFmv != null && synth.neighborsUsed >= 3) {
          noCompCrossParallelAnchor = {
            fmv: Math.round(synth.syntheticFmv * 100) / 100,
            neighborsUsed: synth.neighborsUsed,
            neighborsConsidered: synth.neighborsConsidered,
            parallelTier: synth.anchor?.parallelTier ?? null,
            confidenceCap: synth.confidenceCap,
            anchor: synth.anchor,
            trend: synth.trend,
            triggerReason: "no-direct-comps",
            detail: synth.detail,
            momentumAdjustedFmv: null,
            momentumPctApplied: null,
            weeksStale: null,
            effectiveWeeksApplied: null,
            momentumSource: null,
          };
          noCompEffectiveFmv = Math.round(synth.syntheticFmv * 100) / 100;
          console.log(
            `[compiq.computeEstimate] no-comp cross-parallel anchor: fmv=$${synth.syntheticFmv} from ${synth.neighborsUsed}/${synth.neighborsConsidered} sibling comps`
          );
        }
      }
    } catch (err: any) {
      console.warn(`[compiq.computeEstimate] no-comp cross-parallel synthesis failed:`, err?.message ?? err);
    }

    return {
      cardTitle,
      verdict,
      action: "Hold",
      dealScore: null,
      quickSaleValue: null,
      fairMarketValue: null,
      premiumValue: null,
      explanation: [verdict],
      marketDNA: {
        demand: "Unknown",
        speed: "Unknown",
        risk: "High",
        trend: "Flat",
        marketCondition: "Insufficient Data",
      },
      marketRegime: {
        regime: "illiquid",
        volatilityPct: 0,
        slopePctPerComp: 0,
        confidence: 0.2,
        note: "No usable recent comps.",
      },
      normalization: {
        parallelInput: body.parallel ?? null,
        parallelCanonical: normalizedParallel ?? null,
        gradeCompanyInput: body.gradeCompany ?? null,
        gradeCompanyCanonical: normalizedGradeCompany ?? null,
      },
      confidence: { pricingConfidence: 0, liquidityConfidence: 0, timingConfidence: 0 },
      exitStrategy: {
        recommendedMethod: "wait",
        expectedDaysToSell: null,
        timingRecommendation: "Wait for fresh comps before pricing this card.",
      },
      freshness: {
        status: "Needs refresh" as const,
        lastUpdated: null,
      },
      pricingAnalytics: null,
      estimate: null,
      compsUsed: fetched.comps.length,
      compsAvailable: fetched.comps.length,
      cardIdentity,
      // Return EVERY comp we found (no slice). When the prediction can't be
      // made the iOS UI shows the raw sales so the user can eyeball the
      // market themselves instead of seeing an empty "insufficient" screen.
      recentComps: fetched.comps
        .slice()
        .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
        .map((c) => ({ price: c.price, title: c.title, soldDate: c.soldDate, grade: formatGradeLabel(c.title) })),
      gradeUsed: cardHedgeGrade,
      source: "no-recent-comps",
      daysSinceNewestComp: daysSinceNewest,
      variantWarning: fetched.variantWarning,
      crossParallelAnchor: noCompCrossParallelAnchor,
      effectiveFmv: noCompEffectiveFmv,
    };
  }

  // --- Broader-pool trend signal -------------------------------------------
  // Anchor stays on the exact card_id's direct sales (handled in pricing
  // pipeline below). Trend % comes from every similar card in the same
  // player + year + set, so even a thin/rare variant gets a market-wide
  // direction reading.
  const broaderTrend = cardIdentity
    ? await fetchBroaderTrend(cardIdentity, cardHedgeGrade, fetched.comps).catch(() => null)
    : null;

  // Find the most recent exact-match sale to serve as the anchor.
  const sortedExact = fetched.comps
    .slice()
    .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0));
  const anchorSale = sortedExact[0] ?? null;

  // Filter out numbered serials (/499, #/50, etc.) unless the request explicitly specifies a parallel.
  // This prevents refractors/prizms from skewing the base card FMV.
  const hasParallel = Boolean(body.parallel);
  const serialPattern = /(?:#\s*\/\s*|\/)\s*\d{1,4}(?:\b|$)/i;
  const filteredComps = hasParallel
    ? rawComps
    : rawComps.filter((c) => !serialPattern.test(c.title));
  // Fall back to unfiltered pool if filtering leaves too few comps
  const compsPool = filteredComps.length >= 3 ? filteredComps : rawComps;

  // --- Parallel keyword post-filter ---
  // Keeps only comps that mention the requested parallel (e.g. "Blue Raywave" or "Blue /99").
  // For multi-token parallels (e.g. "blue refractor") require ALL ≥3-char
  // tokens to appear in the comp title (AND match) so we don't pool plain
  // refractors with the blue refractor variant. Falls back progressively to
  // longest-token then full pool when fewer than 3 match so we never go dark.
  function applyParallelFilter(pool: RawComp[], parallel: string): RawComp[] {
    const lower = parallel.trim().toLowerCase();
    const tokens = lower.split(/\s+/).filter((w) => w.length >= 3);
    if (tokens.length === 0) return pool;

    // Strict AND match across all distinguishing tokens.
    const andMatch = pool.filter((c) => {
      const t = c.title.toLowerCase();
      return tokens.every((tok) => t.includes(tok));
    });
    if (andMatch.length >= 3) return andMatch;

    // Fallback: full-phrase substring match.
    const fullMatch = pool.filter((c) => c.title.toLowerCase().includes(lower));
    if (fullMatch.length >= 3) return fullMatch;

    // Last resort: longest single distinguishing token.
    const distinctWord = tokens.slice().sort((a, b) => b.length - a.length)[0];
    if (distinctWord) {
      const wordMatch = pool.filter((c) => c.title.toLowerCase().includes(distinctWord));
      if (wordMatch.length >= 3) return wordMatch;
    }
    return pool; // can't narrow further — keep full pool
  }

  // --- Auto/autograph post-filter ---
  // When the request is for an autograph variant, keep only comps whose title
  // mentions "auto" / "autograph" / "signed". Falls back to the unfiltered
  // pool if narrowing leaves fewer than 3 comps.
  function applyAutoFilter(pool: RawComp[]): RawComp[] {
    const autoRegex = /\b(auto|autograph|autographed|signed)\b/i;
    const filtered = pool.filter((c) => autoRegex.test(c.title));
    return filtered.length >= 3 ? filtered : pool;
  }

  // --- Grade keyword post-filter ---
  // When a grade is requested (e.g. "PSA 10"), only use comps that carry that grade in their title.
  function applyGradeFilter(pool: RawComp[], gradeStr: string): RawComp[] {
    const lower = gradeStr.trim().toLowerCase();
    const gradeMatch = pool.filter((c) => c.title.toLowerCase().includes(lower));
    return gradeMatch.length >= 3 ? gradeMatch : pool;
  }

  let refinedPool = compsPool;
  if (normalizedParallel) refinedPool = applyParallelFilter(refinedPool, normalizedParallel);
  if (effectiveIsAuto) refinedPool = applyAutoFilter(refinedPool);
  if (normalizedGradeCompany && body.gradeValue !== undefined) {
    refinedPool = applyGradeFilter(refinedPool, `${normalizedGradeCompany} ${body.gradeValue}`);
  }

  const regime = detectMarketRegime(refinedPool);

  // ── Grader-premium normalization (Pricing Accuracy — Improvement 3) ─────
  // Convert every comp's sale price into a raw-equivalent before pooling, so
  // PSA10 + BGS9.5 + raw sales contribute to a single anchor. After the
  // pipeline computes the raw anchor we re-apply the target card's grader
  // premium below.
  //
  // `originalPrice` preserves the ORIGINAL Card Hedge sale price for each
  // comp so the user-facing `recentComps` payload can surface what each
  // card actually sold for instead of the engine's internal raw-equivalent
  // intermediate value. Internal anchor math continues to use the
  // normalized `price`. See issue #24.
  const targetPremium = getGraderPremium(normalizedGradeCompany, body.gradeValue?.toString());
  const normalizedRefinedPool: (RawComp & { originalPrice: number })[] = refinedPool.map((c) => ({
    ...c,
    originalPrice: c.price,
    price: normalizeCompToRaw(c),
  }));

  const comps = normalizedRefinedPool.map((c) => ({
    price: c.price,
    originalPrice: c.originalPrice,
    title: c.title,
    date: c.soldDate,
    source: "ebay",
    id: `${c.price}-${c.soldDate}`,
  }));

  // Build context for the pipeline
  const soldCount30d = comps.length;
  // Estimate active listings as ~40% of 30-day sold count (typical sell-through ratio for sports cards).
  // This gives an absorptionRate > 1.0 (sellers' market) for active cards rather than always 1.0.
  const activeListings = Math.max(1, Math.round(soldCount30d * 0.4));
  const context: {
    soldCount30d: number;
    activeListings: number;
    avgDaysToSell: number;
    volatilityIndex: number;
    rankingTrend: string;
    trendProjection?: {
      projectedPrice: number;
      rSquared: number;
      slope: number;
      confidence: number;
    };
    anchorModel?: {
      anchorPrice: number;
      anchorDate: string | null;
      longTermMultiplier: number;
      shortTermMultiplier: number;
      netTrendMultiplier: number;
      impliedTrendPct: number;
    };
    compPoolDebug?: {
      totalNormalized: number;
      exactMatchForTrend: number;
      usingFallbackPool: boolean;
    };
  } = {
    soldCount30d,
    activeListings,
    avgDaysToSell: 7,
    volatilityIndex: 40,
    rankingTrend: "flat",
  };

  // Run predictive analytics pipeline
  const result = DynamicPricingOrchestrator.run(subject, comps, context);

  // --- Override trend % with broader-pool signal ---------------------------
  // Anchor PRICE stays whatever the orchestrator picked from the exact comps,
  // but the trend direction/magnitude is driven by all similar cards in the
  // same player+year+set pool. This keeps a thin card with 2 direct sales
  // from showing a flat or noisy trend when the broader market is moving.
  if (broaderTrend && broaderTrend.basedOn !== "insufficient") {
    const anchorPrice = context.anchorModel?.anchorPrice ?? anchorSale?.price ?? 0;
    const anchorDate = context.anchorModel?.anchorDate ?? anchorSale?.soldDate ?? null;
    const net = 1 + broaderTrend.impliedTrendPct / 100;
    context.anchorModel = {
      anchorPrice,
      anchorDate,
      longTermMultiplier: net,
      shortTermMultiplier: net,
      netTrendMultiplier: Math.max(0.7, Math.min(1.5, net)),
      impliedTrendPct: broaderTrend.impliedTrendPct,
    };
  }

  const usedFallback = result.observability?.usedFallback ?? false;
  let { quickSaleValue, fairMarketValue, premiumValue } = result.priceLanes;

  // Re-apply the target card's grader premium. The orchestrator received
  // raw-normalized prices (Improvement 3), so its priceLanes are "raw
  // equivalent" — multiply by the requested grade's coefficient to land
  // the prediction back in the right grade band.
  const normalizedAnchorRaw = typeof fairMarketValue === "number" ? fairMarketValue : null;
  if (targetPremium !== 1.0) {
    if (typeof quickSaleValue === "number") quickSaleValue = quickSaleValue * targetPremium;
    if (typeof fairMarketValue === "number") fairMarketValue = fairMarketValue * targetPremium;
    if (typeof premiumValue === "number") premiumValue = premiumValue * targetPremium;
  }

  // ── Data Sufficiency Gate (Pricing Accuracy — Improvement 4) ────────────
  // Never publish a point price below the minimum-viable comp threshold.
  const dataSufficiency = evaluateDataSufficiency({
    usedComps: comps.length,
    totalComps: compQualityInfo.totalComps,
    recentCount: broaderTrend?.recentCount ?? 0,
  });
  if (!dataSufficiency.sufficient) {
    quickSaleValue = null as unknown as number;
    fairMarketValue = null as unknown as number;
    premiumValue = null as unknown as number;
  }

  // Map confidence bundle (ConfidenceEngine returns 0–100 integers already)
  // and then clamp each leg through the comp-volume gating ceiling so the
  // user never sees confidence=100 on a thin/illiquid card.
  const confidenceBundle = result.confidence ?? {};
  const rawPricing = Math.min(100, confidenceBundle.pricingConfidence ?? 60);
  const rawLiquidity = Math.min(100, confidenceBundle.liquidityConfidence ?? 60);
  const rawTiming = Math.min(100, confidenceBundle.timingConfidence ?? 60);
  const pricingConfidence = calibrateConfidence(rawPricing, comps);
  const liquidityConfidence = calibrateConfidence(rawLiquidity, comps);
  const timingConfidence = calibrateConfidence(rawTiming, comps);

  // Map marketDNA
  const dna = result.marketDNA ?? {};
  const marketSpeed = result.market?.marketSpeed ?? "normal";
  const marketPressure = result.market?.marketPressure ?? "balanced";
  const demandMap: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
  const speedMap: Record<string, string> = { fast: "Fast", normal: "Normal", slow: "Slow" };
  const riskMap: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
  const trendMap: Record<string, string> = { up: "Up", flat: "Flat", down: "Down" };
  const pressureMap: Record<string, string> = {
    buyers: "Buyer's Market",
    sellers: "Seller's Market",
    balanced: "Balanced Market",
  };

  // Freshness
  const now = new Date().toISOString();
  const freshnessStatus = usedFallback
    ? ("Needs refresh" as const)
    : comps.length > 0
    ? ("Live" as const)
    : ("Needs refresh" as const);

  // ── PlayerIQ writes (fire-and-forget, never block the estimate response) ──
  // 1) Log this card's broaderTrend to trend_history for the per-card chart
  //    and as input for the player-level market score aggregation.
  // 2) Refresh the player's PlayerScore in player_trends so /api/playeriq
  //    returns up-to-date numbers without needing the nightly batch.
  if (cardIdentity && broaderTrend) {
    const yearRaw = cardIdentity.year;
    const yearNum =
      typeof yearRaw === "number"
        ? yearRaw
        : typeof yearRaw === "string" && /^\d+$/.test(yearRaw)
        ? Number(yearRaw)
        : null;
    writeTrendSnapshot({
      cardId: cardIdentity.card_id,
      playerName: cardIdentity.player ?? "",
      year: yearNum,
      set: cardIdentity.set ?? null,
      cardNumber: cardIdentity.number ?? null,
      grade: cardHedgeGrade,
      broaderTrend,
      fairMarketValue: typeof fairMarketValue === "number" ? fairMarketValue : null,
      anchorPrice: context.anchorModel?.anchorPrice ?? null,
    });
  }
  if (cardIdentity?.player) {
    void updatePlayerScoreFromEstimate(cardIdentity.player);
  }

  // ── Buy Window Score + Confidence Interval ────────────────────────────
  const bwTrendDirection: "up" | "down" | "flat" = broaderTrend?.direction ?? "flat";
  const bwTrendPct = broaderTrend?.impliedTrendPct ?? 0;
  const bwRecent = broaderTrend?.recentCount ?? 0;
  const bwOlder = broaderTrend?.olderCount ?? 0;
  const bwBasedOn: BroaderTrend["basedOn"] = broaderTrend?.basedOn ?? "insufficient";
  const printRun = parsePrintRun(body.parallel) ?? parsePrintRun(normalizedParallel);
  const buyWindow = computeBuyWindowScore({
    trendDirection: bwTrendDirection,
    trendPct: bwTrendPct,
    recentCount: bwRecent,
    olderCount: bwOlder,
    basedOn: bwBasedOn,
    signalMultiplier: typeof (result as any).signals?.todayMultiplier === "number"
      ? (result as any).signals?.todayMultiplier
      : undefined,
    month: new Date().getUTCMonth() + 1,
    printRun,
    grade: cardHedgeGrade,
  });
  const confidenceInterval = computeConfidenceInterval({
    predictedPrice: typeof fairMarketValue === "number" ? fairMarketValue : 0,
    recentCount: bwRecent,
    olderCount: bwOlder,
    basedOn: bwBasedOn,
    trendPct: bwTrendPct,
  });

  const sellingGuidance = buildSellingGuidance({
    quickSaleValue: typeof quickSaleValue === "number" ? quickSaleValue : null,
    fairMarketValue: typeof fairMarketValue === "number" ? fairMarketValue : null,
    premiumValue: typeof premiumValue === "number" ? premiumValue : null,
    comps: comps.map((c) => ({ price: c.price, date: c.date ?? null })),
    recommendedMethod: result.exitStrategy?.recommendedMethod ?? null,
    marketSpeed: result.market?.marketSpeed ?? null,
    demand: dna.demand ?? null,
  });

  // ── Cross-parallel synthesis (companion FMV) ─────────────────────────────
  // When direct CH comps are thin (<5) OR stale (newest > 45 days), pull
  // comps from sibling parallels of the same player+year+set and run the
  // neighbor-synthesis engine. This does NOT replace the live FMV — it's
  // exposed as `crossParallelAnchor` so the iOS UI can show both:
  //   "$36 from 3 direct comps / $80 implied from related parallels"
  let crossParallelAnchor: {
    fmv: number;
    neighborsUsed: number;
    neighborsConsidered: number;
    parallelTier: string | null;
    confidenceCap: number;
    anchor: any;
    trend: any;
    triggerReason: string;
    detail: any[];
    momentumAdjustedFmv: number | null;
    momentumPctApplied: number | null;
    weeksStale: number | null;
    effectiveWeeksApplied: number | null;
    momentumSource: string | null;
  } | null = null;
  let effectiveFmv: number | null = typeof fairMarketValue === "number" ? fairMarketValue : null;
  try {
    const newestCompMs = comps.reduce<number>((m, c) => {
      const t = c.date ? Date.parse(c.date) : NaN;
      return Number.isFinite(t) && t > m ? t : m;
    }, 0);
    const ageDays = newestCompMs > 0 ? (Date.now() - newestCompMs) / (24 * 3600 * 1000) : Infinity;
    const isThin = comps.length < 5;
    const isStale = ageDays > 45;
    if (isThin || isStale) {
      const triggerReason = [
        isThin ? `thin(${comps.length}<5)` : null,
        isStale ? `stale(newest=${Number.isFinite(ageDays) ? ageDays.toFixed(0) : "∞"}d)` : null,
      ]
        .filter(Boolean)
        .join("+");
      const { fetchSiblingParallelComps } = await import("./cardhedge.client.js");
      const siblings = await fetchSiblingParallelComps({
        playerName: body.playerName ?? "",
        year: body.cardYear ?? cardIdentity?.year ?? null,
        set: body.product ?? cardIdentity?.set ?? null,
        excludeCardId: cardIdentity?.card_id ?? null,
        grade: cardHedgeGrade,
        perSiblingLimit: 6,
        maxSiblings: 12,
      });
      if (siblings.length >= 3) {
        const { synthesizeFromNeighbors } = await import("./neighborSynthesis.js");
        const { parseCardQuery: parseFn } = await import("./cardQueryParser.js");
        const targetParsed = parseFn(cardTitle);
        if (effectiveIsAuto) targetParsed.isAuto = true;
        if (normalizedParallel) targetParsed.parallel = normalizedParallel;
        if (body.cardYear) targetParsed.year = body.cardYear;
        const synth = synthesizeFromNeighbors(
          targetParsed,
          siblings.map((s) => ({ title: s.title, price: s.price, soldDate: s.soldDate ?? undefined })),
          { trendWindowDays: 60 }
        );
        if (synth.syntheticFmv != null && synth.neighborsUsed >= 3) {
          // ── Momentum lift on the stale live FMV ────────────────────────
          // The cross-parallel synthesis gives us (a) an absolute synthetic
          // price from parallel multipliers — which is only reliable when
          // the neighbor parallel tier is classified — and (b) a temporal
          // trend on the player's adjacent market, which is reliable even
          // when absolute multipliers are uncertain (it's just measuring
          // sibling prices over time, not absolute level).
          //
          // We use the TREND signal to lift the live (stale) FMV forward
          // in time. Caps prevent extrapolating a noisy weekly slope across
          // many months.
          let momentumAdjustedFmv: number | null = null;
          let momentumPctApplied: number | null = null;
          let weeksStaleVal: number | null = null;
          let effectiveWeeksApplied: number | null = null;
          let momentumSource: string | null = null;
          const liveFmv =
            typeof fairMarketValue === "number" && fairMarketValue > 0
              ? fairMarketValue
              : null;
          const slopePct =
            typeof synth.trend?.slopePctPerWeek === "number"
              ? synth.trend.slopePctPerWeek
              : null;
          const weeklySamples =
            typeof synth.trend?.weeklySamples === "number"
              ? synth.trend.weeklySamples
              : 0;
          if (
            liveFmv != null &&
            slopePct != null &&
            Number.isFinite(slopePct) &&
            weeklySamples >= 3 &&
            Number.isFinite(ageDays) &&
            ageDays > 0
          ) {
            weeksStaleVal = ageDays / 7;
            // Never extrapolate beyond ~2× the sample window we actually
            // observed; never beyond 12 weeks regardless. Floor at 1 week.
            const maxExtrapolationWeeks = Math.max(
              1,
              Math.min(12, weeklySamples * 2)
            );
            effectiveWeeksApplied = Math.min(
              weeksStaleVal,
              maxExtrapolationWeeks
            );
            // Clamp cumulative move to ±35% so a noisy slope can't
            // double or halve the price.
            const rawMomentumPct = (effectiveWeeksApplied * slopePct) / 100;
            momentumPctApplied = Math.max(-0.35, Math.min(0.35, rawMomentumPct));
            momentumAdjustedFmv =
              Math.round(liveFmv * (1 + momentumPctApplied) * 100) / 100;
            momentumSource = `sibling-trend(${synth.trend!.direction},${slopePct.toFixed(2)}%/wk,n=${weeklySamples})`;
            console.log(
              `[compiq.computeEstimate] momentum lift: liveFmv=$${liveFmv} × (1 + ${(momentumPctApplied * 100).toFixed(1)}%) = $${momentumAdjustedFmv} ` +
                `(weeksStale=${weeksStaleVal.toFixed(1)}, applied=${effectiveWeeksApplied.toFixed(1)}wks, slope=${slopePct.toFixed(2)}%/wk, n=${weeklySamples})`
            );
            // Only swap the displayed FMV when the lift is meaningful and
            // we have a healthy sibling trend signal — the live anchor is
            // ALWAYS preserved in `fairMarketValue` so the UI can show both.
            if (Math.abs(momentumPctApplied) >= 0.05 && weeklySamples >= 4) {
              effectiveFmv = momentumAdjustedFmv;
            }
          }

          crossParallelAnchor = {
            fmv: Math.round(synth.syntheticFmv * 100) / 100,
            neighborsUsed: synth.neighborsUsed,
            neighborsConsidered: synth.neighborsConsidered,
            parallelTier: synth.anchor?.parallelTier ?? null,
            confidenceCap: synth.confidenceCap,
            anchor: synth.anchor,
            trend: synth.trend,
            triggerReason,
            detail: synth.detail,
            momentumAdjustedFmv,
            momentumPctApplied,
            weeksStale: weeksStaleVal,
            effectiveWeeksApplied,
            momentumSource,
          };
          console.log(
            `[compiq.computeEstimate] cross-parallel anchor: fmv=$${synth.syntheticFmv} from ${synth.neighborsUsed}/${synth.neighborsConsidered} sibling comps (reason=${triggerReason})`
          );
        }
      }
    }
  } catch (err: any) {
    console.warn(
      `[compiq.computeEstimate] cross-parallel synthesis failed:`,
      err?.message ?? err
    );
  }

  return {
    cardTitle,
    verdict: result.verdict ?? "Hold",
    action: result.action ?? "Hold",
    dealScore: result.dealScore ?? 50,
    quickSaleValue,
    fairMarketValue,
    premiumValue,
    explanation: result.explanationBullets?.length
      ? result.explanationBullets
      : ["Estimate based on available market data."],
    marketDNA: {
      demand: demandMap[dna.demand] ?? "Medium",
      speed: speedMap[marketSpeed] ?? "Normal",
      risk: riskMap[dna.risk] ?? "Medium",
      trend: trendMap[dna.trend] ?? "Flat",
      marketCondition: pressureMap[marketPressure] ?? "Balanced Market",
    },
    marketRegime: regime,
    normalization: {
      parallelInput: body.parallel ?? null,
      parallelCanonical: normalizedParallel ?? null,
      gradeCompanyInput: body.gradeCompany ?? null,
      gradeCompanyCanonical: normalizedGradeCompany ?? null,
    },
    confidence: { pricingConfidence, liquidityConfidence, timingConfidence },
    exitStrategy: {
      recommendedMethod: result.exitStrategy?.recommendedMethod ?? "auction",
      expectedDaysToSell: result.exitStrategy?.expectedDaysToSell ?? null,
      timingRecommendation:
        result.exitStrategy?.timingRecommendation ?? "List when market activity increases.",
    },
    freshness: {
      status: freshnessStatus,
      lastUpdated: comps.length > 0 ? now : null,
    },
    pricingAnalytics: context.trendProjection || context.anchorModel
      ? {
          projectedNextSale: context.trendProjection?.projectedPrice ?? null,
          trendSlope: context.trendProjection?.slope ?? null,
          rSquared: context.trendProjection?.rSquared ?? null,
          projectionConfidence: context.trendProjection?.confidence ?? null,
          anchorModel: context.anchorModel ?? null,
          compPoolDebug: context.compPoolDebug ?? null,
        }
      : null,
    broaderTrend,
    buyWindowScore: buyWindow.score,
    buyWindowLabel: buyWindow.label,
    buyWindowReasons: buyWindow.reasons,
    confidenceInterval,
    sellingGuidance,
    crossParallelAnchor,
    effectiveFmv,
    compQuality: compQualityInfo,
    graderPremium: {
      applied: targetPremium,
      company: normalizedGradeCompany ?? null,
      grade: body.gradeValue ?? null,
      normalizedAnchor: normalizedAnchorRaw,
    },
    dataSufficiency,
    estimate: fairMarketValue,
    compsUsed: comps.length,
    cardIdentity,
    recentComps: comps
      .slice()
      .sort((a, b) => {
        const ta = Date.parse(a.date || "") || 0;
        const tb = Date.parse(b.date || "") || 0;
        return tb - ta;
      })
      .slice(0, 10)
      .map((c) => ({
        // Display the ORIGINAL Card Hedge sale price (not the post-
        // normalizeCompToRaw raw-equivalent intermediate). See issue #24.
        price: c.originalPrice,
        title: c.title,
        soldDate: c.date,
        grade: formatGradeLabel(c.title),
      })),
    gradeUsed: cardHedgeGrade,
    source: comps.length > 0 ? "live" : "fallback",
    variantWarning: fetched.variantWarning,
  };
}

export async function simulateWhatIf(body: {
  playerName: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: number;
  isAuto?: boolean;
  buyPrice?: number;
  holdDays?: number;
  feePct?: number;
  shippingCost?: number;
}): Promise<Record<string, unknown>> {
  const estimate = await computeEstimate({
    playerName: body.playerName,
    cardYear: body.cardYear,
    product: body.product,
    parallel: body.parallel,
    gradeCompany: body.gradeCompany,
    gradeValue: body.gradeValue,
    isAuto: body.isAuto,
  });

  const buyPrice = Math.max(0.01, Number(body.buyPrice ?? (estimate.fairMarketValue as number) ?? 0));
  const holdDays = Math.max(1, Math.min(365, Number(body.holdDays ?? 45)));
  const feePct = Math.max(0, Math.min(0.3, Number(body.feePct ?? 0.12)));
  const shippingCost = Math.max(0, Number(body.shippingCost ?? 5));

  const fair = Number(estimate.fairMarketValue ?? 0);
  const regime = (estimate.marketRegime as RegimeSummary | undefined) ?? {
    regime: "stable",
    volatilityPct: 15,
    slopePctPerComp: 0,
    confidence: 0.5,
    note: "Default regime",
  };

  const driftByRegime: Record<RegimeSummary["regime"], number> = {
    momentum: 0.06,
    "mean-reversion": -0.03,
    illiquid: -0.01,
    stable: 0.02,
  };
  const horizonFactor = holdDays / 30;
  const drift = driftByRegime[regime.regime] * horizonFactor;
  const sigma = (regime.volatilityPct / 100) * Math.sqrt(Math.max(0.5, horizonFactor));

  const base = Math.max(1, fair * (1 + drift));
  const bear = Math.max(1, base * (1 - Math.max(0.05, sigma * 0.8)));
  const bull = Math.max(base, base * (1 + Math.max(0.06, sigma)));

  function scenario(price: number) {
    const gross = price;
    const net = gross * (1 - feePct) - shippingCost;
    const pnl = net - buyPrice;
    const roiPct = buyPrice > 0 ? (pnl / buyPrice) * 100 : 0;
    return {
      projectedSalePrice: Number(gross.toFixed(2)),
      projectedNet: Number(net.toFixed(2)),
      pnl: Number(pnl.toFixed(2)),
      roiPct: Number(roiPct.toFixed(2)),
    };
  }

  return {
    assumptions: {
      buyPrice,
      holdDays,
      feePct,
      shippingCost,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
    },
    scenarios: {
      bear: scenario(bear),
      base: scenario(base),
      bull: scenario(bull),
    },
    estimate,
  };
}

export async function compiqEstimate(req: Request, res: Response) {
  const data = await computeEstimate(req.body || {});
  // Stamp engine identity marker (pricingEngine / engineVersion / computedAt).
  // Non-breaking: existing clients ignore unknown JSON fields.
  //
  // Corpus wiring status: the Tier 3 collector (PR #2b) wires the free-text
  // query endpoints (/search, /price, /price-by-id, /bulk). /estimate is
  // deferred pending schema support for structured-input corpus rows
  // (querySource: "structured" — separate PR). See followup queue. The
  // synthesize-free-text approach was rejected because it would pollute
  // the training set with fake free-text rows that don't represent real
  // user input.
  res.json({ ...data, ...buildEngineMeta() });
}
