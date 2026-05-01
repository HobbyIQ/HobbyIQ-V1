/**
 * Trend-based pricing engine via Apify eBay sold listings.
 *
 * Prices cards based on current market direction, recency-weighted sales,
 * and outlier-controlled comp analysis — NOT a simple median.
 */

export interface SoldComp {
  price: number;
  title: string;
  date: string;
  url: string;
  grade?: string;
}

export interface TrendAnalysis {
  market_direction: "up" | "down" | "flat" | "volatile" | "unclear";
  recent_sales_pattern: string;
  older_sales_pattern: string;
  change_from_older_to_recent: string;
  liquidity: "high" | "medium" | "low";
  trend_confidence: number;
  windows: {
    last7: { count: number; avgPrice: number | null };
    last14: { count: number; avgPrice: number | null };
    last30: { count: number; avgPrice: number | null };
    last60: { count: number; avgPrice: number | null };
    last90: { count: number; avgPrice: number | null };
  };
}

export interface OutlierComp extends SoldComp {
  reason_ignored_or_reduced: string;
}

export interface CardSearchResult {
  success: boolean;
  query: string;
  summary: string;
  marketTier: { entry: number; fair: number; premium: number };
  buyZone: [number, number];
  holdZone: [number, number];
  sellZone: [number, number];
  recentComps: SoldComp[];
  outliers: OutlierComp[];
  trendAnalysis: TrendAnalysis;
  supply: { activeListings: null; trend2w: null; trend4w: null; trend3m: null };
  confidence: number;
  source: "live" | "mock";
  valuationMethod: "trend-based";
  gradeTierUsed: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

type GradeLabel =
  | "psa10"
  | "psa9_5"
  | "psa9"
  | "psa8"
  | "bgs9_5"
  | "bgs9"
  | "sgc10"
  | "sgc9"
  | "graded_other"
  | "raw";

/**
 * Detect the grade of a card from its eBay listing title.
 * Returns "raw" if no grading company + score is found.
 */
function detectGrade(text: string): GradeLabel {
  const t = text.toLowerCase();
  if (/psa[\s-]?10\b/.test(t)) return "psa10";
  if (/psa[\s-]?9\.5\b/.test(t)) return "psa9_5";
  if (/psa[\s-]?9\b/.test(t)) return "psa9";
  if (/psa[\s-]?8\b/.test(t)) return "psa8";
  if (/bgs[\s-]?9\.5\b/.test(t)) return "bgs9_5";
  if (/bgs[\s-]?9\b/.test(t)) return "bgs9";
  if (/sgc[\s-]?10\b/.test(t)) return "sgc10";
  if (/sgc[\s-]?9\b/.test(t)) return "sgc9";
  if (/\b(psa|bgs|sgc|cgc|hga|csg)\b/.test(t)) return "graded_other";
  return "raw";
}

function medianOf(prices: number[]): number {
  if (!prices.length) return 0;
  const s = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function avgOf(prices: number[]): number {
  if (!prices.length) return 0;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

function stdDevOf(prices: number[]): number {
  if (prices.length < 2) return 0;
  const avg = avgOf(prices);
  return Math.sqrt(prices.reduce((s, p) => s + (p - avg) ** 2, 0) / prices.length);
}

function ageInDays(dateStr: string, now: number): number {
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 999;
  return (now - t) / DAY_MS;
}

function windowFilter(comps: SoldComp[], maxDays: number, now: number): SoldComp[] {
  return comps.filter((c) => ageInDays(c.date, now) <= maxDays);
}

function windowAvg(comps: SoldComp[], maxDays: number, now: number): number | null {
  const w = windowFilter(comps, maxDays, now);
  return w.length ? parseFloat(avgOf(w.map((c) => c.price)).toFixed(2)) : null;
}

/**
 * IQR-based outlier detection.
 * Items below Q1 - 2.0*IQR or above Q3 + 2.0*IQR are flagged as outliers.
 * Uses a multiplier of 2.0 (vs classic 1.5) to be less aggressive — sports card
 * markets have naturally wide price variance across grades and parallels.
 */
function separateOutliers(comps: SoldComp[]): { clean: SoldComp[]; outliers: OutlierComp[] } {
  if (comps.length < 4) return { clean: comps, outliers: [] };

  const sorted = [...comps].sort((a, b) => a.price - b.price);
  const prices = sorted.map((c) => c.price);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 2.0 * iqr;
  const hi = q3 + 2.0 * iqr;

  const clean: SoldComp[] = [];
  const outliers: OutlierComp[] = [];

  for (const c of comps) {
    if (c.price < lo) {
      outliers.push({ ...c, reason_ignored_or_reduced: `Price $${c.price} is far below Q1 ($${q1.toFixed(0)}) — possible mislisted, damaged, or non-auto variant` });
    } else if (c.price > hi) {
      outliers.push({ ...c, reason_ignored_or_reduced: `Price $${c.price} exceeds upper fence ($${hi.toFixed(0)}) — possible 1/1, superfractor, hype spike, or mislisted high-end variant` });
    } else {
      clean.push(c);
    }
  }

  // Always keep at least 3 clean comps even if outlier logic removes too many
  if (clean.length < 3 && comps.length >= 3) {
    const byDistance = [...comps].sort((a, b) => {
      const med = medianOf(comps.map((c) => c.price));
      return Math.abs(a.price - med) - Math.abs(b.price - med);
    });
    return { clean: byDistance.slice(0, Math.max(3, Math.floor(comps.length * 0.6))), outliers: [] };
  }

  return { clean, outliers };
}

/**
 * Recency-weighted mean using exponential decay.
 * Half-life = 14 days: a sale from 14 days ago counts ~50% of today's sale.
 */
function recencyWeightedPrice(comps: SoldComp[], now: number, halfLifeDays = 14): number {
  if (!comps.length) return 0;
  let totalWeight = 0;
  let totalValue = 0;
  for (const c of comps) {
    const age = ageInDays(c.date, now);
    const weight = Math.exp((-0.693 * age) / halfLifeDays);
    totalWeight += weight;
    totalValue += c.price * weight;
  }
  return totalWeight > 0 ? totalValue / totalWeight : 0;
}

/**
 * Trend detection: compares the recent window (≤14 days) vs older window (15–90 days).
 * Falls back to 30-day vs older split if recent window is thin.
 */
function detectTrend(
  clean: SoldComp[],
  now: number,
): {
  direction: "up" | "down" | "flat" | "volatile" | "unclear";
  changePercent: number;
  recentCluster: SoldComp[];
  olderCluster: SoldComp[];
} {
  // Try 14-day split first; fall back to 30-day if recent is thin
  let recentCluster = windowFilter(clean, 14, now);
  let olderCluster = clean.filter((c) => ageInDays(c.date, now) > 14);

  if (recentCluster.length < 2) {
    recentCluster = windowFilter(clean, 30, now);
    olderCluster = clean.filter((c) => ageInDays(c.date, now) > 30);
  }

  // Check overall volatility on all clean comps
  const allPrices = clean.map((c) => c.price);
  const cv = allPrices.length > 1 ? stdDevOf(allPrices) / avgOf(allPrices) : 0;

  if (cv > 0.55 && clean.length >= 5) {
    return { direction: "volatile", changePercent: 0, recentCluster, olderCluster };
  }

  if (!recentCluster.length || !olderCluster.length) {
    return { direction: "unclear", changePercent: 0, recentCluster, olderCluster };
  }

  const recentMed = medianOf(recentCluster.map((c) => c.price));
  const olderMed = medianOf(olderCluster.map((c) => c.price));
  const changePercent = ((recentMed - olderMed) / olderMed) * 100;

  let direction: "up" | "down" | "flat" | "volatile" | "unclear";
  if (changePercent > 10) direction = "up";
  else if (changePercent < -10) direction = "down";
  else direction = "flat";

  return { direction, changePercent, recentCluster, olderCluster };
}

/**
 * Apply a trend multiplier to the recency-weighted base price.
 * Up market → boost; down market → reduce; volatile → uncertainty discount.
 */
function applyTrendMultiplier(
  basePrice: number,
  direction: "up" | "down" | "flat" | "volatile" | "unclear",
  changePercent: number,
): number {
  switch (direction) {
    case "up": {
      // Cap the boost at 20% regardless of raw changePercent to avoid runaway estimates
      const boost = Math.min(0.20, Math.abs(changePercent) / 100 * 0.5);
      return basePrice * (1 + boost);
    }
    case "down": {
      const reduction = Math.min(0.20, Math.abs(changePercent) / 100 * 0.5);
      return basePrice * (1 - reduction);
    }
    case "volatile":
      // Uncertainty discount: current value skews toward the lower-recent cluster
      return basePrice * 0.95;
    case "flat":
    case "unclear":
    default:
      return basePrice;
  }
}

// ─── Apify fetch ──────────────────────────────────────────────────────────────

async function fetchEbaySoldData(query: string): Promise<SoldComp[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.warn("[compiqSearch] APIFY_TOKEN not set — skipping live fetch");
    return [];
  }

  try {
    const url =
      "https://api.apify.com/v2/acts/caffein.dev~ebay-sold-listings/run-sync-get-dataset-items" +
      `?token=${token}&timeout=55&memory=512`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: [query],
        count: 30,
        daysToScrape: 90,
        ebaySite: "ebay.com",
        sortOrder: "endedRecently",
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[compiqSearch] Apify responded ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return [];

    return data
      .filter((item) => parseFloat(String(item.soldPrice ?? "0")) > 0)
      .map((item) => ({
        price: parseFloat(String(item.soldPrice)),
        title: (item.title as string) || "",
        date: (item.endedAt as string) || "",
        url: (item.url as string) || "",
      }));
  } catch (err) {
    console.warn("[compiqSearch] Apify fetch failed:", (err as Error).message);
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function searchAndPrice(query: string): Promise<CardSearchResult> {
  const now = Date.now();
  const rawComps = await fetchEbaySoldData(query);

  if (!rawComps.length) {
    const emptyTrend: TrendAnalysis = {
      market_direction: "unclear",
      recent_sales_pattern: "No sales data available",
      older_sales_pattern: "No sales data available",
      change_from_older_to_recent: "N/A",
      liquidity: "low",
      trend_confidence: 0,
      windows: {
        last7: { count: 0, avgPrice: null },
        last14: { count: 0, avgPrice: null },
        last30: { count: 0, avgPrice: null },
        last60: { count: 0, avgPrice: null },
        last90: { count: 0, avgPrice: null },
      },
    };
    return {
      success: true,
      query,
      summary: "No recent eBay sales found for this query. Try a more specific search.",
      marketTier: { entry: 0, fair: 0, premium: 0 },
      buyZone: [0, 0],
      holdZone: [0, 0],
      sellZone: [0, 0],
      recentComps: [],
      outliers: [],
      trendAnalysis: emptyTrend,
      supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
      confidence: 0,
      source: "live",
      valuationMethod: "trend-based",
      gradeTierUsed: "none",
    };
  }

  // Tag each comp with its detected grade (for display/transparency only)
  const taggedComps: SoldComp[] = rawComps.map((c) => ({
    ...c,
    grade: detectGrade(c.title),
  }));

  // Sort newest first
  const sorted = [...taggedComps].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  // Note what grade the query implies (informational only)
  const gradeTierUsed = detectGrade(query);

  // Separate outliers from clean comps (all comps — grade is transparent in each comp's title)
  const { clean, outliers } = separateOutliers(sorted);

  // Trend detection on clean comps
  const { direction, changePercent, recentCluster, olderCluster } = detectTrend(clean, now);

  // Base price: recency-weighted mean of clean comps
  const weightedBase = recencyWeightedPrice(clean, now);

  // Apply trend adjustment
  const currentValue = applyTrendMultiplier(weightedBase, direction, changePercent);

  // Historical median of the pricing pool (sanity check only, not the primary value)
  const historicalMedian = medianOf(sorted.map((c) => c.price));

  // Window stats
  const w7 = windowFilter(clean, 7, now);
  const w14 = windowFilter(clean, 14, now);
  const w30 = windowFilter(clean, 30, now);
  const w60 = windowFilter(clean, 60, now);
  const w90 = windowFilter(clean, 90, now);

  // Liquidity
  const liquidity: "high" | "medium" | "low" =
    clean.length >= 15 ? "high" : clean.length >= 6 ? "medium" : "low";

  // Trend confidence: more sales + split between windows = more confident
  const hasBothClusters = recentCluster.length >= 2 && olderCluster.length >= 2;
  const rawTrendConf =
    (Math.min(clean.length, 20) / 20) * 0.6 + (hasBothClusters ? 0.4 : 0.1);
  const trendConfidence = parseFloat(Math.min(0.95, rawTrendConf).toFixed(2));

  // Confidence for the iOS display value
  const displayConfidence =
    liquidity === "high" && hasBothClusters
      ? 0.85
      : liquidity === "medium" || hasBothClusters
        ? 0.65
        : 0.4;

  // Pricing tiers
  const fair = parseFloat(currentValue.toFixed(2));
  const entry = parseFloat((currentValue * 0.82).toFixed(2));
  const premium = parseFloat((currentValue * 1.22).toFixed(2));

  // Buy / hold / sell zones tighter than old model
  const buyZone: [number, number] = [
    parseFloat((entry * 0.88).toFixed(2)),
    parseFloat((entry * 1.04).toFixed(2)),
  ];
  const holdZone: [number, number] = [
    parseFloat((fair * 0.94).toFixed(2)),
    parseFloat((fair * 1.08).toFixed(2)),
  ];
  const sellZone: [number, number] = [
    parseFloat((premium * 0.94).toFixed(2)),
    parseFloat((premium * 1.18).toFixed(2)),
  ];

  // Narrative patterns
  const recentAvg = recentCluster.length ? avgOf(recentCluster.map((c) => c.price)) : null;
  const olderAvg = olderCluster.length ? avgOf(olderCluster.map((c) => c.price)) : null;

  const recentPattern =
    recentCluster.length >= 2
      ? `${recentCluster.length} sales averaging $${recentAvg!.toFixed(0)}`
      : recentCluster.length === 1
        ? `1 recent sale at $${recentCluster[0].price}`
        : "No recent sales in comparison window";

  const olderPattern =
    olderCluster.length >= 2
      ? `${olderCluster.length} older sales averaging $${olderAvg!.toFixed(0)}`
      : olderCluster.length === 1
        ? `1 older sale at $${olderCluster[0].price}`
        : "No older sales in comparison window";

  const changeDesc =
    direction === "unclear" || !recentAvg || !olderAvg
      ? "Insufficient data for trend comparison"
      : `${changePercent > 0 ? "+" : ""}${changePercent.toFixed(1)}% vs older sales cluster`;

  // Plain-English summary (trend-based, not median-based)
  let summary: string;
  const dirWord =
    direction === "up"
      ? "trending up"
      : direction === "down"
        ? "trending down"
        : direction === "volatile"
          ? "volatile"
          : direction === "flat"
            ? "flat"
            : "unclear in direction";

  if (direction === "up" || direction === "down") {
    summary =
      `Recent sales show this card is ${dirWord} (${changeDesc}). ` +
      `Historical median was $${historicalMedian.toFixed(0)}, but it is less useful here because recent sales are trending ${direction === "up" ? "higher" : "lower"}. ` +
      `Trend-adjusted current value: $${fair.toFixed(0)}. Confidence: ${displayConfidence >= 0.8 ? "High" : displayConfidence >= 0.6 ? "Medium" : "Low"}.`;
  } else if (direction === "flat") {
    summary =
      `Market is ${dirWord} with ${recentPattern}. ` +
      `Current value estimate: $${fair.toFixed(0)}. Confidence: ${displayConfidence >= 0.8 ? "High" : displayConfidence >= 0.6 ? "Medium" : "Low"}.`;
  } else {
    summary =
      `Market is ${dirWord} across ${clean.length} clean comps. ` +
      `Recency-weighted estimate: $${fair.toFixed(0)}. Confidence: ${displayConfidence >= 0.8 ? "High" : displayConfidence >= 0.6 ? "Medium" : "Low"}.`;
  }

  const trendAnalysis: TrendAnalysis = {
    market_direction: direction,
    recent_sales_pattern: recentPattern,
    older_sales_pattern: olderPattern,
    change_from_older_to_recent: changeDesc,
    liquidity,
    trend_confidence: trendConfidence,
    windows: {
      last7: { count: w7.length, avgPrice: w7.length ? parseFloat(avgOf(w7.map((c) => c.price)).toFixed(2)) : null },
      last14: { count: w14.length, avgPrice: w14.length ? parseFloat(avgOf(w14.map((c) => c.price)).toFixed(2)) : null },
      last30: { count: w30.length, avgPrice: w30.length ? parseFloat(avgOf(w30.map((c) => c.price)).toFixed(2)) : null },
      last60: { count: w60.length, avgPrice: w60.length ? parseFloat(avgOf(w60.map((c) => c.price)).toFixed(2)) : null },
      last90: { count: w90.length, avgPrice: w90.length ? parseFloat(avgOf(w90.map((c) => c.price)).toFixed(2)) : null },
    },
  };

  return {
    success: true,
    query,
    summary,
    marketTier: { entry, fair, premium },
    buyZone,
    holdZone,
    sellZone,
    recentComps: clean.slice(0, 10),
    outliers,
    trendAnalysis,
    supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
    confidence: displayConfidence,
    source: "live",
    valuationMethod: "trend-based",
    gradeTierUsed,
  };
}
