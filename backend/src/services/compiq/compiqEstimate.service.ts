import { Request, Response } from "express";
import { CompIQEstimateRequest } from "../../types/compiq.types.js";
import { DynamicPricingOrchestrator } from "../../modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js";
import { normalizeGradeCompany, normalizeParallel } from "./normalizationDictionary.service.js";
import { type CardHedgeCard } from "./cardhedge.client.js";
import { findCompsRouted, searchCardsRouted, getCardSalesRouted, type QueryContext } from "./cardsight.router.js";
import { parseCardQuery } from "./cardQueryParser.js";
import { writeTrendSnapshot } from "../playerScore/trendHistory.service.js";
import { updatePlayerScoreFromEstimate } from "../playerScore/playerScore.service.js";
import { buildEngineMeta } from "./engineMeta.js";
import { classifyRegime } from "./regimeClassifier.js";
import { computePredictedRange, type PredictedRangeResult } from "./predictedRange.js";
// Issue #25 Phase 3 — tier-anchored predicted-range fallback (default OFF).
// Activated by env flag COMPIQ_PHASE3_TIER_ANCHORED=true. NEVER replaces the
// Phase 2 result; only augments when Phase 2 returns { low: null, high: null }.
import { computeTierAnchoredRange, type TierAnchoredResult } from "./predictedRangeTierAnchored.js";
import { buildPeerPool } from "./peerPoolBuilder.js";
import { getParallelAttributesLookup } from "./parallelAttributesLookup.js";
// Issue #25 Phase 3 REBUILD — multiplier-anchored predictedRange. Fires
// inside the variant-mismatch cross-parallel synthesis branch when sibling
// comps for the same player/year/set are available. Never replaces
// effectiveFmv; ADDS a forward-looking range alongside the synthesized FMV.
import {
  computeMultiplierAnchoredRange,
  type MultiplierAnchoredResult,
} from "./predictedRangeMultiplierAnchored.js";
import { computeMultiplierAnchoredPredictedPrice } from "../../agents/multiplierAnchoredPredictedPrice.js";
// TrendIQ Phase 1 (docs/phase0/trendiq_design.md) — forward-looking
// composite score. B.4.a wires Layer 1 only (player momentum from the
// signal aggregator); Layers 2 and 3 follow in B.4.b/c. The composite
// function already handles all 8 weight-table rows, so the response
// shape is stable across the phased rollout — missing layers just
// shift the weights per the locked matrix.
import { fetchPlayerSignals } from "../signals/fetchSignals.js";
// CF-CARDSIGHT-SIBLING-DISCOVERY (2026-05-25 investigation, Approach A) —
// fetchSiblingSales wraps fetchCompsByPlayer + exact-card-id exclusion.
// See docs/phase0/cardsight_sibling_discovery_investigation.md.
import { fetchCompsByPlayer } from "./compsByPlayer.service.js";
import {
  buildPlayerMomentumComponent,
  computeCardTrajectory,
  computeSegmentTrajectory,
  computeTrendIQ,
  formatTrendIQLogLine,
} from "./trendIQ.compute.js";

// Issue #25 Phase 3 — trim peer-pool diagnostics for the wire response.
// We keep counts only; sample comp data is not surfaced to the client.
function __extractPhase3Diags(
  d: Awaited<ReturnType<typeof buildPeerPool>>["diagnostics"],
) {
  return {
    primarySetCount: d.primarySetCount,
    fallbackSetsUsed: d.fallbackSetsUsed,
    fallbackPeerCount: d.fallbackPeerCount,
    totalCompsConsidered: d.totalCompsConsidered,
    dropCounts: d.dropCounts,
    nullReason: d.nullReason,
  };
}

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

// ── Sibling-sales pool (shared by fetchBroaderTrend + Layer 3 trajectory) ─
//
// Pre-fetches sales for same-player + same-year + same-set siblings of the
// resolved card_id (exact card_id excluded). Both fetchBroaderTrend (existing
// fixed-from-now trend) and computeSegmentTrajectory (new TrendIQ Layer 3
// last-sale-anchored trend) consume this same pool so we never double-fetch
// the same sibling sales across one estimate request.
//
// Caps: 8 siblings, 10 samples each. Same as the pre-refactor inlined values.
//
// Fallback param (Option A — added 2026-05-26 during B.4.c.3 live smoke):
// The Cardsight-exclusive resolved card identity often lacks `setName` /
// `year` (gap captured as CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS). Without
// fallback, fetchSiblingSales gate-tripped on `!set` for every Cardsight
// card and returned an empty pool — affecting both Layer 3 (no segment
// trajectory ever fired) AND the pre-existing fetchBroaderTrend (which
// silently fell back to exact-comp-only pool, mislabeling its 'broader
// trend' for unknown duration). Caller now passes `parsedQuery`-derived
// fields as fallback; sibling discovery uses them when cardIdentity is
// sparse.
export interface SiblingSalesPool {
  /** Sibling card_ids actually fetched (0..8 after filtering + cap). */
  siblingCardIds: string[];
  /** Flat sale list, pre-filtered for valid Date.parse + price > 0. */
  sales: Array<{ price: number; ts: number }>;
}

/**
 * Parse a grade string ("PSA 10" / "BGS 9.5" / "Raw") into the
 * gradeCompany + gradeValue shape that fetchCompsByPlayer accepts.
 *
 * Returns empty object for raw / ungraded / unparseable inputs — segment
 * trajectory then pools all grades, which is the right behavior for raw-
 * card queries (no graded-tier scoping makes sense).
 */
function parseGradeStringForCardsight(
  grade: string,
): { gradeCompany?: string; gradeValue?: string } {
  if (!grade) return {};
  const lower = grade.toLowerCase().trim();
  if (lower === "" || lower === "raw" || lower === "ungraded") return {};
  const m = grade.match(/^(PSA|BGS|SGC|CGC)\s*([0-9]+(?:\.5)?)$/i);
  if (!m) return {};
  return { gradeCompany: m[1].toUpperCase(), gradeValue: m[2] };
}

export async function fetchSiblingSales(
  card: NonNullable<FetchedComps["card"]>,
  grade: string,
): Promise<SiblingSalesPool> {
  // CF-CARDSIGHT-SIBLING-DISCOVERY Approach A (2026-05-25):
  // Wrap fetchCompsByPlayer + exact-card-id exclusion. fetchCompsByPlayer is
  // a production-tested service (shipped 2026-05-27 for adjacent MCP-rewire
  // flow) that handles searchCatalog + releaseName dictionary lookup +
  // chrome-fallback + top-K pricing fanout + 6h aggregate cache + dedupe.
  // See docs/phase0/cardsight_sibling_discovery_investigation.md for the
  // investigation that picked Approach A over B/C/D.
  //
  // CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS (2026-05-25):
  // Previously took a `fallback?: SiblingSalesFallback` parameter populated
  // from parsedQuery, because cardIdentity.set/year were structurally
  // undefined for Cardsight-exclusive cards. Phase 2 of this CF augments
  // findCompsViaCardsight to populate cardIdentity from getCardDetail's
  // rich response, eliminating the gap. The fallback is no longer needed
  // and has been retired — cardIdentity is now the true source of truth
  // for player + product + year.
  //
  // Same-grade scoping: parse the grade string and pass to
  // fetchCompsByPlayer so PSA 10's segment pool is built from PSA 10 sales
  // of related cards (not raw or other grades). Raw queries pass undefined
  // → segment includes all grades.
  const player = (card.player ?? "").trim();
  const product = (card.set ?? "").trim();
  const yearRaw = card.year ?? null;
  const cardYear =
    yearRaw != null && Number.isFinite(Number(yearRaw))
      ? Number(yearRaw)
      : undefined;
  const parsedGrade = parseGradeStringForCardsight(grade);

  console.log(
    `[compiq.trendIQ.L3.fetch] player="${player}" product="${product}" ` +
      `year=${cardYear ?? "null"} grade="${grade}" ` +
      `gradeParsed=${JSON.stringify(parsedGrade)}`,
  );

  if (!player || !product) {
    console.log(
      `[compiq.trendIQ.L3.fetch] early-return: missing player or product ` +
        `on cardIdentity (CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS post-fix; ` +
        `if this fires often, getCardDetail augmentation may be degrading)`,
    );
    return { siblingCardIds: [], sales: [] };
  }

  // Outer try/catch — fetchCompsByPlayer can throw on aggregate-level errors
  // (its per-candidate failures are already tolerated internally).
  let result;
  try {
    result = await fetchCompsByPlayer({
      playerName: player,
      product,
      cardYear,
      gradeCompany: parsedGrade.gradeCompany,
      gradeValue: parsedGrade.gradeValue,
    });
  } catch (err) {
    console.log(
      `[compiq.trendIQ.L3.fetch] fetchCompsByPlayer threw: ` +
        `${(err as Error)?.message ?? err}`,
    );
    return { siblingCardIds: [], sales: [] };
  }

  // Exclude exact card_id from both cardIds + comps. Segment-trajectory
  // semantics per locked B.2 design: pool is SIBLINGS only (related cards
  // in the same player + product + year segment, EXCLUDING the exact card
  // being valued).
  const exactCardId = card.card_id;
  const siblingCardIds = result.cardIds.filter((id) => id !== exactCardId);
  const excludedCardIds = result.cardIds.length - siblingCardIds.length;

  const sales: Array<{ price: number; ts: number }> = [];
  let excludedComps = 0;
  for (const c of result.comps) {
    if (c.cardId === exactCardId) {
      excludedComps++;
      continue;
    }
    const ts = Date.parse(c.date || "");
    if (Number.isFinite(ts) && c.price > 0) {
      sales.push({ price: c.price, ts });
    }
  }

  console.log(
    `[compiq.trendIQ.L3.fetch] fetchCompsByPlayer returned ` +
      `cardIds=${result.cardIds.length} comps=${result.comps.length} ` +
      `cached=${result.cached} warnings=${result.warnings.length}; ` +
      `post-exclusion siblings=${siblingCardIds.length} sales=${sales.length} ` +
      `(excluded cardIds=${excludedCardIds} comps=${excludedComps})`,
  );
  if (result.warnings.length > 0) {
    console.log(
      `[compiq.trendIQ.L3.fetch] warnings: ${JSON.stringify(result.warnings)}`,
    );
  }

  return { siblingCardIds, sales };
}

async function fetchBroaderTrend(
  card: NonNullable<FetchedComps["card"]>,
  grade: string,
  exactComps: RawComp[],
  pool: SiblingSalesPool,
): Promise<BroaderTrend> {
  const RECENT_DAYS = 14;
  const OLDER_DAYS = 45; // 15..45-day window

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

  const player = (card.player ?? "").trim();
  const set = (card.set ?? "").trim();
  if (!player || !set) return blankOut("insufficient");

  // Combine sibling pool with exact comps for the trend math. fetchBroaderTrend
  // intentionally pools exact + siblings together (existing behavior, pre-
  // refactor). Layer 3 segment trajectory consumes the SAME `pool` but does
  // NOT fold in exact comps — see computeSegmentTrajectory.
  const siblingIds = pool.siblingCardIds;
  const combined: Array<{ price: number; ts: number }> = [...pool.sales];
  for (const c of exactComps) {
    const ts = Date.parse(c.soldDate || "");
    if (Number.isFinite(ts) && c.price > 0) {
      combined.push({ price: c.price, ts });
    }
  }

  if (combined.length === 0) return blankOut("insufficient");

  const now = Date.now();
  const recentCutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
  const olderCutoff = now - OLDER_DAYS * 24 * 3600 * 1000;

  const recent = combined.filter((p) => p.ts >= recentCutoff);
  const older = combined.filter((p) => p.ts < recentCutoff && p.ts >= olderCutoff);

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
      totalSamples: combined.length,
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
    totalSamples: combined.length,
    windowRecentDays: RECENT_DAYS,
    windowOlderDays: OLDER_DAYS,
    basedOn: siblingIds.length > 0 ? "broader" : "exact",
  };
}

async function fetchComps(
  query: string,
  grade: string = "Raw",
  pinnedCardId?: string,
  queryContext?: QueryContext
): Promise<FetchedComps> {
  // CARD_HEDGE_API_KEY gate removed 2026-05-25 — see fetchBroaderTrend
  // comment above. Under CARDSIGHT_MODE=exclusive (production setting),
  // findCompsRouted goes directly to Cardsight; CardHedge auth is not a
  // dependency of this path.

  // ----- Phase 2 — meaningful-query fall-through ------------------------
  // Re-applies the routing change from PR #110 (originally shipped as
  // commit 9124e54, reverted as 83ea415, attempted as Step A standalone
  // PR as commit f5cd3e7, rolled back same-day pending Phase 2's
  // queryContext plumbing + dictionary expansion).
  //
  // When the iOS client sends a meaningful `query` text alongside
  // cardHedgeCardId, fetchComps falls through to findCompsRouted →
  // resolveCardId → Cardsight getPricing under CARDSIGHT_MODE=exclusive.
  // The cardHedgeCardId remains the prediction cache key in the route
  // layer — only the fetch path changes.
  //
  // The `query !== pinnedCardId` check guards against iOS sending the
  // opaque cardId as the query (iOS resolvedLabel falls back to cardId
  // when displayLabel/title are both empty — see
  // HobbyIQ/CompIQSearchModels.swift).
  const trimmedQuery = (query ?? "").trim();
  const hasMeaningfulQuery =
    trimmedQuery.length > 0 &&
    pinnedCardId !== undefined &&
    trimmedQuery !== pinnedCardId.trim();

  // ----- Card-Ladder-style pinned card_id path --------------------------
  // When the iOS client picked a specific Card Hedge card from the search
  // list AND no meaningful free-text query came along, take the legacy
  // cardhedge-namespace path. Under CARDSIGHT_MODE=exclusive this returns
  // [] (router's cardIdSource=cardhedge guard fires) — the correct
  // fallback when there's no text to drive a Cardsight catalog lookup.
  if (pinnedCardId && !hasMeaningfulQuery) {
    const sales = await getCardSalesRouted(pinnedCardId, grade, 25, { cardIdSource: "cardhedge" });
    // Pull set/player/variant for display by looking up via search (best effort).
    let identityCard: any = null;
    try {
      const hits = await searchCardsRouted(query || pinnedCardId, 20);
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

  const { card, sales, variantWarning, aiCategory } = await findCompsRouted(query, { grade, limit: 25, queryContext });

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

  // Phase 2 — queryContext plumbing.
  //
  // Threads body's structured fields through fetchComps → findCompsRouted →
  // toCardsightQuery → resolveCardId so the catalog lookup uses the user's
  // intended playerName / year / product / parallel instead of the joined
  // cardTitle string (which contained sport-suffix + cardNumber noise that
  // contaminated playerName extraction inside the router).
  //
  // /price arrives structured (parseCardQuery already ran upstream in the
  // /price route via requestFromParsed). /estimate arrives structured per
  // CompIQEstimateRequest. /price-by-id sends body.playerName as the free-
  // text iOS displayLabel; we defensively re-parse it here when structured
  // fields are absent so the catalog lookup still gets clean inputs.
  const needsParseFallback =
    !body.cardYear &&
    !body.product &&
    typeof body.playerName === "string" &&
    /\b(19|20)\d{2}\b/.test(body.playerName);
  const parsed = needsParseFallback ? parseCardQuery(body.playerName!) : null;

  // When the defensive parse fires (parsed != null), body.playerName is the
  // raw iOS displayLabel — prefer parsed.playerName which has sport-suffix /
  // cardNumber / set-name noise stripped. When parse didn't fire, body's
  // playerName is already structured (set by /price's requestFromParsed or
  // /estimate's structured client body). Same logic for the other fields.
  const queryContext: QueryContext = {
    playerName: parsed?.playerName ?? body.playerName ?? undefined,
    cardYear: body.cardYear ?? parsed?.year ?? undefined,
    product: body.product ?? parsed?.set ?? undefined,
    parallel: body.parallel ?? parsed?.parallel ?? undefined,
    // Phase 2 v2 defect #11 — thread cardNumber so resolveCardId disambiguates
    // via detail-probe + LRU cache key includes it. Body's cardNumber comes
    // from /price route's requestFromParsed (set in this PR); parsed.cardNumber
    // is the /price-by-id defensive parse of an iOS displayLabel.
    cardNumber: body.cardNumber ?? parsed?.cardNumber ?? undefined,
    gradeCompany: normalizedGradeCompany ?? parsed?.gradingCompany ?? undefined,
    gradeValue:
      body.gradeValue !== undefined
        ? String(body.gradeValue)
        : parsed?.grade ?? undefined,
  };

  let fetched = await fetchComps(cardTitle, cardHedgeGrade, body.cardHedgeCardId, queryContext);

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
      marketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: null,
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
  // "base" means no distinguishing parallel token — comp titles don't contain
  // the word "base", so injecting it here would cause isCompVariantMatch to
  // reject every valid base comp and trigger the variant-mismatch guard.
  if (normalizedParallel && normalizedParallel !== "base") parsedForGuard.parallel = normalizedParallel;
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
    const mechanism1 = computeMultiplierAnchoredPredictedPrice({
      subject: {
        playerName: body.playerName ?? fetched.card?.player ?? "",
        year: Number(body.cardYear ?? fetched.card?.year ?? 0),
        product: (body.product?.includes("Draft") ? "Bowman Draft" : "Bowman Chrome") as "Bowman Chrome" | "Bowman Draft",
        subset: "Chrome Prospect Autographs",
        parallelName: normalizedParallel ?? body.parallel ?? "",
        isAutograph: effectiveIsAuto,
      },
      comps: fetched.comps.map((c) => ({
        title: c.title,
        price: c.price,
        soldDate: c.soldDate,
      })),
    });

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
      `[compiq.computeEstimate] variant-mismatch guard tripped: query="${cardTitle}" reason="${missing}"`
    );

    return {
      cardTitle,
      verdict: `No comps found for this exact variant (missing: ${missing}). Card Hedge doesn't have sold data for this card yet.`,
      action: "Hold",
      dealScore: 0,
      quickSaleValue: null,
      fairMarketValue: null,
      marketValue: null,
      predictedPrice: mechanism1.predictedPrice,
      predictedPriceRange: mechanism1.predictedPriceRange,
      predictedPriceAttribution: mechanism1.predictedPriceAttribution,
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
      crossParallelAnchor: null,
      effectiveFmv: null,
      dataSufficiency: {
        sufficient: false,
        level: "none" as const,
        message: `Variant not found (missing: ${missing}).`,
      },
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
    const mechanism1 = computeMultiplierAnchoredPredictedPrice({
      subject: {
        playerName: body.playerName ?? fetched.card?.player ?? "",
        year: Number(body.cardYear ?? fetched.card?.year ?? 0),
        product: (body.product?.includes("Draft") ? "Bowman Draft" : "Bowman Chrome") as "Bowman Chrome" | "Bowman Draft",
        subset: "Chrome Prospect Autographs",
        parallelName: normalizedParallel ?? body.parallel ?? "",
        isAutograph: effectiveIsAuto,
      },
      comps: fetched.comps.map((c) => ({
        title: c.title,
        price: c.price,
        soldDate: c.soldDate,
      })),
    });

    const ageNote =
      daysSinceNewest != null
        ? `last comp was ${daysSinceNewest} days ago`
        : "no comps on file";
    const verdict = `Insufficient recent comps — ${ageNote}. Refine the query or wait for fresh sales.`;
    console.warn(
      `[compiq.computeEstimate] thin-data short-circuit: comps=${fetched.comps.length} daysSinceNewest=${daysSinceNewest} query="${cardTitle}"`
    );

    // CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING (2026-05-26):
    // Before returning "no-recent-comps", try the sibling-pool rescue path.
    // Approach A pattern from CF-CARDSIGHT-SIBLING-DISCOVERY (e2d5864):
    // when direct Cardsight returns thin comps for a variant card, the
    // sibling pool (same player + product + year, different parallels)
    // often has dozens of sales we can use as a broader proxy for pricing.
    //
    // Variant filters (parallel/auto/grade) are deliberately NOT applied to
    // the sibling pool — siblings are different cards by construction;
    // narrowing them by exact-variant tokens defeats the rescue purpose.
    // The verdict text "Estimated from similar cards — variant unverified"
    // communicates the source clearly to downstream consumers.
    //
    // Confidence capped at 65 (vs direct-match's 95) reflects the
    // lower-precision nature of sibling-derived pricing. Variable confidence
    // based on sibling-pool quality is a follow-up CF.
    if (cardIdentity) {
      let siblingPool: SiblingSalesPool = { siblingCardIds: [], sales: [] };
      try {
        siblingPool = await fetchSiblingSales(cardIdentity, cardHedgeGrade);
      } catch (err) {
        console.warn(
          `[compiq.computeEstimate] sibling-pool rescue: fetchSiblingSales threw — falling through to "no-recent-comps": ${(err as Error)?.message ?? err}`
        );
      }

      if (siblingPool.sales.length > 0) {
        const directSales: Array<{ price: number; ts: number }> = fetched.comps
          .map((c) => ({ price: c.price, ts: Date.parse(c.soldDate || "") }))
          .filter((s) => Number.isFinite(s.ts) && s.price > 0);
        const combinedSales = [...directSales, ...siblingPool.sales];
        const combinedNewestTs = combinedSales.reduce((max, s) => Math.max(max, s.ts), 0);
        const combinedDaysSinceNewest =
          combinedNewestTs > 0
            ? Math.floor((Date.now() - combinedNewestTs) / (24 * 3600 * 1000))
            : null;
        const combinedCount = combinedSales.length;

        // Same sufficiency thresholds as the direct-pool check (line 1562-1567).
        const stillInsufficient =
          combinedCount === 0 ||
          (combinedCount === 1 && (combinedDaysSinceNewest == null || combinedDaysSinceNewest > 14)) ||
          (combinedCount === 2 && (combinedDaysSinceNewest == null || combinedDaysSinceNewest > 180)) ||
          (combinedCount >= 3 && (combinedDaysSinceNewest == null || combinedDaysSinceNewest > 365));

        if (!stillInsufficient) {
          const sortedPrices = combinedSales.map((s) => s.price).sort((a, b) => a - b);
          const fairMarketValue =
            sortedPrices.length % 2 === 1
              ? sortedPrices[(sortedPrices.length - 1) / 2]
              : (sortedPrices[sortedPrices.length / 2 - 1] + sortedPrices[sortedPrices.length / 2]) / 2;
          const round2 = (n: number) => Math.round(n * 100) / 100;
          const fmv = round2(fairMarketValue);
          const quickSaleValue = round2(fmv * 0.88);
          const premiumValue = round2(fmv * 1.15);
          const suggestedListPrice = round2(fmv * 1.05);

          // Confidence: scale with combined-pool size + recency, then cap at 65.
          const recencyFactor =
            combinedDaysSinceNewest == null || combinedDaysSinceNewest > 90
              ? 0.6
              : combinedDaysSinceNewest > 30
              ? 0.8
              : 1.0;
          const sizeFactor = Math.min(1.0, combinedCount / 12);
          const computedConfidence = Math.round(80 * sizeFactor * recencyFactor);
          const pricingConfidence = Math.min(65, computedConfidence);

          const freshness =
            combinedDaysSinceNewest != null && combinedDaysSinceNewest <= 60 ? "Live" : "Stale";

          const siblingVerdict = "Estimated from similar cards — variant unverified";

          console.log(
            `[compiq.computeEstimate] sibling-pool rescue SUCCESS: direct=${directSales.length} ` +
              `sibling=${siblingPool.sales.length} combined=${combinedCount} ` +
              `daysSinceNewest=${combinedDaysSinceNewest} fmv=${fmv} confidence=${pricingConfidence} ` +
              `query="${cardTitle}"`
          );

          return {
            cardTitle,
            verdict: siblingVerdict,
            action: "Hold",
            dealScore: 0,
            quickSaleValue,
            fairMarketValue: fmv,
            marketValue: fmv,
            premiumValue,
            suggestedListPrice,
            predictedPrice: mechanism1.predictedPrice,
            predictedPriceRange: mechanism1.predictedPriceRange,
            predictedPriceAttribution: mechanism1.predictedPriceAttribution,
            explanation: [siblingVerdict],
            marketDNA: {
              demand: "Mixed",
              speed: "Normal",
              risk: "Medium",
              trend: "Flat",
              marketCondition: "Sibling-pool estimate",
            },
            marketRegime: {
              regime: "stable",
              volatilityPct: 0,
              slopePctPerComp: 0,
              confidence: pricingConfidence / 100,
              note: "Estimated from sibling pool — variant unverified.",
            },
            normalization: {
              parallelInput: body.parallel ?? null,
              parallelCanonical: normalizedParallel ?? null,
              gradeCompanyInput: body.gradeCompany ?? null,
              gradeCompanyCanonical: normalizedGradeCompany ?? null,
            },
            confidence: {
              pricingConfidence,
              liquidityConfidence: pricingConfidence,
              timingConfidence: pricingConfidence,
            },
            exitStrategy: {
              recommendedMethod: "list",
              expectedDaysToSell: null,
              timingRecommendation: "Verify variant before listing — pricing is from similar cards.",
            },
            freshness: {
              status: freshness as "Live" | "Stale",
              lastUpdated: new Date().toISOString(),
            },
            pricingAnalytics: null,
            estimate: fmv,
            compsUsed: combinedCount,
            compsAvailable: combinedCount,
            cardIdentity,
            recentComps: fetched.comps
              .slice()
              .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
              .map((c) => ({
                price: c.price,
                title: c.title,
                soldDate: c.soldDate,
                grade: formatGradeLabel(c.title),
              })),
            gradeUsed: cardHedgeGrade,
            source: "sibling-pool",
            daysSinceNewestComp: combinedDaysSinceNewest,
            variantWarning: fetched.variantWarning,
            crossParallelAnchor: null,
            effectiveFmv: fmv,
            dataSufficiency: {
              sufficient: true,
              level: "low" as const,
              message: `Sibling-pool estimate from ${combinedCount} sales across related cards`,
            },
          };
        }
      }
    }

    return {
      cardTitle,
      verdict,
      action: "Hold",
      dealScore: 0,
      quickSaleValue: null,
      fairMarketValue: null,
      marketValue: null,
      predictedPrice: mechanism1.predictedPrice,
      predictedPriceRange: mechanism1.predictedPriceRange,
      predictedPriceAttribution: mechanism1.predictedPriceAttribution,
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
      crossParallelAnchor: null,
      effectiveFmv: null,
      dataSufficiency: {
        sufficient: false,
        level: "none" as const,
        message: ageNote,
      },
    };
  }

  // --- Sibling-sales pool fetch + TrendIQ Layer 1 fetch (parallel) ---------
  // siblingPool: one-shot sibling-sale fetch shared between fetchBroaderTrend
  //              (existing fixed-window trend) and computeSegmentTrajectory
  //              (TrendIQ Layer 3 last-sale-anchored trend). Both run in
  //              parallel with the player-signal fetch since they are
  //              independent network ops.
  // playerSignalsResult: TrendIQ Layer 1 — aggregator's player multiplier.
  const playerNameForSignals =
    cardIdentity?.player?.trim() || body.playerName?.trim() || "";
  // CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS (2026-05-25): parsedQuery
  // fallback retired. findCompsViaCardsight now augments cardIdentity
  // from getCardDetail (rich metadata: releaseName, setName, year),
  // so cardIdentity reliably carries the player/product/year fields
  // sibling-discovery needs.
  const [siblingPool, playerSignalsResult] = await Promise.all([
    cardIdentity
      ? fetchSiblingSales(cardIdentity, cardHedgeGrade).catch(() => ({
          siblingCardIds: [] as string[],
          sales: [] as Array<{ price: number; ts: number }>,
        }))
      : Promise.resolve({
          siblingCardIds: [] as string[],
          sales: [] as Array<{ price: number; ts: number }>,
        }),
    playerNameForSignals
      ? fetchPlayerSignals(playerNameForSignals).catch(() => ({ payload: null, sourceUrl: null }))
      : Promise.resolve({ payload: null, sourceUrl: null }),
  ]);
  const broaderTrend = cardIdentity
    ? await fetchBroaderTrend(cardIdentity, cardHedgeGrade, fetched.comps, siblingPool).catch(() => null)
    : null;
  const playerMomentum = buildPlayerMomentumComponent(playerSignalsResult);

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
  // Skip applyParallelFilter for "base" — base card comps don't carry the
  // word "base" as a variant token, so filtering on it drops all valid comps.
  if (normalizedParallel && normalizedParallel !== "base") refinedPool = applyParallelFilter(refinedPool, normalizedParallel);
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

  // ADR-0003 (Phase 3.2 option 3): neighbor synthesis removed.
  // Keep placeholders for compatibility until routes/clients stop reading
  // companion fields.
  const crossParallelAnchor = null;
  const effectiveFmv: number | null = typeof fairMarketValue === "number" ? fairMarketValue : null;

  // Issue #25 Phase 2 — compute regime + predicted range (read-only).
  // No pricing math reads from these fields.
  const regimeClassificationResult = classifyRegime(
    comps.map((c) => ({ price: c.originalPrice, date: c.date ?? null })),
  );
  const predictedRangeResultLocal: PredictedRangeResult = computePredictedRange({
    comps: comps.map((c) => ({
      price: c.originalPrice,
      title: c.title,
      date: c.date ?? null,
    })),
    targetGrade:
      normalizedGradeCompany && body.gradeValue !== undefined
        ? `${normalizedGradeCompany} ${body.gradeValue}`
        : "Raw",
    regimeResult: regimeClassificationResult,
    source: "live",
  });

  // ─── Issue #25 Phase 3 — tier-anchored fallback predicted range ──────────
  // Runs ONLY when:
  //   1. COMPIQ_PHASE3_TIER_ANCHORED=true (default OFF for safe rollout)
  //   2. Phase 2 returned a null range (no usable direct-parallel comps)
  //   3. The subject card has a `set` from Card Hedge identity
  // This block is purely ADDITIVE — surfaces as a separate response field
  // `predictedRangePhase3`; it never mutates `predictedRangeResult`.
  let predictedRangePhase3: (TierAnchoredResult & {
    peerPoolDiagnostics: ReturnType<typeof __extractPhase3Diags>;
  }) | null = null;
  try {
    const phase3Enabled = String(process.env.COMPIQ_PHASE3_TIER_ANCHORED ?? "")
      .trim()
      .toLowerCase() === "true";
    const phase2NullRange =
      predictedRangeResultLocal.predictedRange.low === null &&
      predictedRangeResultLocal.predictedRange.high === null;
    const subjectSet = (cardIdentity?.set ?? "").trim();
    if (phase3Enabled && phase2NullRange && subjectSet) {
      const subjectIsAuto = body.isAuto === true || (normalizedParallel ?? "").toLowerCase().includes("auto");
      const lookup = getParallelAttributesLookup();
      const peerPoolResult = await buildPeerPool({
        subjectPlayer: cardIdentity?.player ?? body.playerName ?? "",
        subjectSet,
        subjectParallelName: normalizedParallel ?? body.parallel ?? null,
        subjectIsAutograph: subjectIsAuto,
        comps: (fetched.comps ?? []).map((s) => ({
          price: s.price,
          title: s.title ?? "",
          soldDate: s.soldDate ?? null,
        })),
        lookup,
      });
      const tierResult = computeTierAnchoredRange({
        subjectTier: peerPoolResult.subjectTier,
        subjectRegime: regimeClassificationResult.regime ?? null,
        peerPool: peerPoolResult.peerPool,
      });
      predictedRangePhase3 = {
        ...tierResult,
        peerPoolDiagnostics: __extractPhase3Diags(peerPoolResult.diagnostics),
      };
      console.log(
        `[compiq.computeEstimate] Phase 3 tier-anchored fallback: ` +
          `subject="${subjectSet}" parallel="${normalizedParallel ?? "Base"}" ` +
          `subjectTier=${peerPoolResult.subjectTier} peers=${peerPoolResult.peerPool.length} ` +
          `range=${tierResult.predictedRange === null ? "null" : `$${tierResult.predictedRange.low}-$${tierResult.predictedRange.high}`} ` +
          `nullReason=${tierResult.diagnostics.nullReason ?? "none"}`,
      );
    }
  } catch (phase3Err) {
    // Defensive: never let Phase 3 block a price prediction.
    console.warn(
      `[compiq.computeEstimate] Phase 3 fallback failed:`,
      (phase3Err as Error)?.message ?? phase3Err,
    );
    predictedRangePhase3 = null;
  }

  // ── TrendIQ composite (Phase 1 B.4.a + B.4.b + B.4.c: all 3 layers) ────
  // Layer 2 reads from fetched.comps (exact-card pool) — see
  // computeCardTrajectory's coupling note.
  // Layer 3 reads from siblingPool (sibling-sales only, exact excluded)
  // and uses the exact card's most-recent-sale timestamp (newestTs,
  // computed above) as the anchor. Re-anchor + pre-window resolution
  // documented in computeSegmentTrajectory header.
  const cardTrajectory = computeCardTrajectory(
    fetched.comps.map((c) => ({ price: c.price, soldDate: c.soldDate })),
  );
  const segmentTrajectory = computeSegmentTrajectory(siblingPool, newestTs);
  const trendIQ = computeTrendIQ({
    playerMomentum,
    cardTrajectory,
    segmentTrajectory,
  });
  console.log(formatTrendIQLogLine(trendIQ));

  return {
    cardTitle,
    verdict: result.verdict ?? "Hold",
    action: result.action ?? "Hold",
    dealScore: result.dealScore ?? 50,
    quickSaleValue,
    fairMarketValue,
    marketValue: typeof fairMarketValue === "number" ? fairMarketValue : null,
    predictedPrice: null,
    predictedPriceRange: null,
    predictedPriceAttribution: null,
    premiumValue,
    trendIQ,
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
    // Issue #25 Phase 1 — read-only regime classifier. NO pricing math reads
    // from this field; it is surfaced on the API response only.
    regimeClassification: regimeClassificationResult,
    // Issue #25 Phase 2 — read-only predicted range. NO pricing math reads
    // from this field; it is surfaced on the API response only.
    predictedRangeResult: predictedRangeResultLocal,
    // Issue #25 Phase 3 — tier-anchored fallback range. Populated ONLY when
    // env flag COMPIQ_PHASE3_TIER_ANCHORED=true AND Phase 2 returned a null
    // range. Null in all other cases. NO pricing math reads from this field.
    predictedRangePhase3,
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
