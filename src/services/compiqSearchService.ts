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
  parallel?: string;
  normalizedPrice?: number;
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
  marketTrendOverall: {
    queryUsed: string;
    sampleSize: number;
    trend: TrendAnalysis;
  };
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

type ParallelLabel =
  | "one_of_one"
  | "red_5"
  | "orange_25"
  | "gold_50"
  | "green_99"
  | "blue_150"
  | "sapphire_199"
  | "purple_250"
  | "refractor_499"
  | "chrome_base";

interface CardProfile {
  grade: GradeLabel;
  parallel: ParallelLabel;
}

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

function detectParallel(text: string): ParallelLabel {
  const t = text.toLowerCase();

  if (/\b(1\/1|one of one|superfractor|true\s+1\/1)\b/.test(t)) return "one_of_one";
  if (/\bred\b/.test(t) && /\/\s*5\b/.test(t)) return "red_5";
  if (/\borange\b/.test(t) && /\/\s*25\b/.test(t)) return "orange_25";
  if (/\bgold\b/.test(t) && /\/\s*50\b/.test(t)) return "gold_50";
  if (/\bgreen\b/.test(t) && /\/\s*99\b/.test(t)) return "green_99";
  if (/\bblue\b/.test(t) && /\/\s*150\b/.test(t)) return "blue_150";
  if (/\bsapphire\b/.test(t) && /\/\s*199\b/.test(t)) return "sapphire_199";
  if (/\bpurple\b/.test(t) && /\/\s*250\b/.test(t)) return "purple_250";
  if (/\brefractor\b/.test(t) && /\/\s*499\b/.test(t)) return "refractor_499";
  if (/\bblue\b/.test(t)) return "blue_150";
  if (/\bsapphire\b/.test(t)) return "sapphire_199";
  if (/\brefractor\b/.test(t)) return "refractor_499";
  return "chrome_base";
}

function parseCardProfile(text: string): CardProfile {
  return {
    grade: detectGrade(text),
    parallel: detectParallel(text),
  };
}

function gradeMultiplier(grade: GradeLabel): number {
  switch (grade) {
    case "psa10":
      return 1.55;
    case "psa9_5":
      return 1.32;
    case "psa9":
      return 1.18;
    case "psa8":
      return 0.92;
    case "bgs9_5":
      return 1.45;
    case "bgs9":
      return 1.15;
    case "sgc10":
      return 1.4;
    case "sgc9":
      return 1.08;
    case "graded_other":
      return 1.1;
    case "raw":
    default:
      return 1.0;
  }
}

function parallelMultiplier(parallel: ParallelLabel): number {
  switch (parallel) {
    case "one_of_one":
      return 6.0;
    case "red_5":
      return 3.5;
    case "orange_25":
      return 2.2;
    case "gold_50":
      return 1.7;
    case "green_99":
      return 1.35;
    case "blue_150":
      return 1.15;
    case "sapphire_199":
      return 1.2;
    case "purple_250":
      return 1.0;
    case "refractor_499":
      return 0.88;
    case "chrome_base":
    default:
      return 1.0;
  }
}

function profileMultiplier(profile: CardProfile): number {
  return gradeMultiplier(profile.grade) * parallelMultiplier(profile.parallel);
}

function normalizeToTargetProfile(price: number, compProfile: CardProfile, targetProfile: CardProfile): number {
  const sourceMultiplier = profileMultiplier(compProfile);
  const targetMultiplier = profileMultiplier(targetProfile);
  if (sourceMultiplier <= 0 || targetMultiplier <= 0) return price;
  const ratio = targetMultiplier / sourceMultiplier;

  // Keep normalization in a realistic lane so one misclassified comp cannot explode valuation.
  const boundedRatio = Math.max(0.6, Math.min(1.8, ratio));
  return price * boundedRatio;
}

function toWholeMarketQuery(query: string): string {
  let q = query;
  q = q.replace(/\/\s*\d+/g, " ");
  q = q.replace(/\b(blue|red|orange|gold|green|purple|sapphire|wave|superfractor|true\s*1\/1|1\/1)\b/gi, " ");
  q = q.replace(/\b(psa|bgs|sgc|cgc|hga|csg)\s*[-:]?\s*\d+(?:\.\d+)?\b/gi, " ");
  q = q.replace(/\s+/g, " ").trim();
  if (!/\bauto\b/i.test(q)) q = `${q} auto`;
  return q;
}

function profileLabel(profile: CardProfile): string {
  const grade = profile.grade === "raw" ? "raw" : profile.grade.toUpperCase().replace("_", " ");
  const parallelMap: Record<ParallelLabel, string> = {
    one_of_one: "1/1",
    red_5: "Red /5",
    orange_25: "Orange /25",
    gold_50: "Gold /50",
    green_99: "Green /99",
    blue_150: "Blue /150",
    sapphire_199: "Sapphire /199",
    purple_250: "Purple /250",
    refractor_499: "Refractor /499",
    chrome_base: "Chrome base",
  };
  return `${grade} ${parallelMap[profile.parallel]}`;
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
      marketTrendOverall: {
        queryUsed: toWholeMarketQuery(query),
        sampleSize: 0,
        trend: emptyTrend,
      },
    };
  }

  // Tag each comp with detected attributes
  const taggedComps: SoldComp[] = rawComps.map((c) => ({
    ...c,
    grade: detectGrade(c.title),
    parallel: detectParallel(c.title),
  }));

  // Sort newest first
  const sorted = [...taggedComps].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  // Target profile inferred from query (used for normalization)
  const targetProfile = parseCardProfile(query);
  const gradeTierUsed = targetProfile.grade;

  // Whole-market lane: broaden query to capture overall player+set auto trend.
  const overallQuery = toWholeMarketQuery(query);
  const overallRaw =
    overallQuery.toLowerCase() === query.toLowerCase()
      ? rawComps
      : await fetchEbaySoldData(overallQuery);

  // Normalize all comps into target-profile equivalents (single-card fair market lane)
  const normalizedComps: SoldComp[] = sorted.map((c) => {
    const compProfile: CardProfile = {
      grade: (c.grade as GradeLabel) ?? "raw",
      parallel: (c.parallel as ParallelLabel) ?? "chrome_base",
    };
    const normalizedPrice = parseFloat(
      normalizeToTargetProfile(c.price, compProfile, targetProfile).toFixed(2),
    );
    return {
      ...c,
      normalizedPrice,
      price: normalizedPrice,
    };
  });

  // Separate outliers from normalized comp values
  const { clean, outliers } = separateOutliers(normalizedComps);

  // Trend detection on clean comps
  const { direction, changePercent, recentCluster, olderCluster } = detectTrend(clean, now);

  // Base price: recency-weighted mean of clean comps
  const weightedBase = recencyWeightedPrice(clean, now);

  // Apply trend adjustment
  const currentValue = applyTrendMultiplier(weightedBase, direction, changePercent);

  // Historical median in normalized-target terms (sanity check only, not the primary value)
  const historicalMedian = medianOf(normalizedComps.map((c) => c.price));

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
      `Comps were normalized to ${profileLabel(targetProfile)} equivalents before valuation. ` +
      `Historical median was $${historicalMedian.toFixed(0)}, but it is less useful here because recent sales are trending ${direction === "up" ? "higher" : "lower"}. ` +
      `Trend-adjusted current value: $${fair.toFixed(0)}. Confidence: ${displayConfidence >= 0.8 ? "High" : displayConfidence >= 0.6 ? "Medium" : "Low"}.`;
  } else if (direction === "flat") {
    summary =
      `Market is ${dirWord} with ${recentPattern}. ` +
      `Comps were normalized to ${profileLabel(targetProfile)} equivalents. ` +
      `Current value estimate: $${fair.toFixed(0)}. Confidence: ${displayConfidence >= 0.8 ? "High" : displayConfidence >= 0.6 ? "Medium" : "Low"}.`;
  } else {
    summary =
      `Market is ${dirWord} across ${clean.length} clean comps. ` +
      `Comps were normalized to ${profileLabel(targetProfile)} equivalents. ` +
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

  const overallTagged = overallRaw.map((c) => ({
    ...c,
    grade: detectGrade(c.title),
    parallel: detectParallel(c.title),
  }));
  const overallBaseProfile: CardProfile = { grade: "raw", parallel: "chrome_base" };
  const overallNormalized = overallTagged.map((c) => {
    const compProfile: CardProfile = {
      grade: (c.grade as GradeLabel) ?? "raw",
      parallel: (c.parallel as ParallelLabel) ?? "chrome_base",
    };
    return {
      ...c,
      price: parseFloat(normalizeToTargetProfile(c.price, compProfile, overallBaseProfile).toFixed(2)),
    };
  });
  const { clean: overallClean } = separateOutliers(overallNormalized);
  const {
    direction: overallDirection,
    changePercent: overallChangePercent,
    recentCluster: overallRecentCluster,
    olderCluster: overallOlderCluster,
  } = detectTrend(overallClean, now);
  const overallRecentAvg = overallRecentCluster.length ? avgOf(overallRecentCluster.map((c) => c.price)) : null;
  const overallOlderAvg = overallOlderCluster.length ? avgOf(overallOlderCluster.map((c) => c.price)) : null;
  const overallRecentPattern =
    overallRecentCluster.length >= 2
      ? `${overallRecentCluster.length} sales averaging $${overallRecentAvg!.toFixed(0)}`
      : overallRecentCluster.length === 1
        ? `1 recent sale at $${overallRecentCluster[0].price}`
        : "No recent sales in comparison window";
  const overallOlderPattern =
    overallOlderCluster.length >= 2
      ? `${overallOlderCluster.length} older sales averaging $${overallOlderAvg!.toFixed(0)}`
      : overallOlderCluster.length === 1
        ? `1 older sale at $${overallOlderCluster[0].price}`
        : "No older sales in comparison window";
  const overallChangeDesc =
    overallDirection === "unclear" || !overallRecentAvg || !overallOlderAvg
      ? "Insufficient data for trend comparison"
      : `${overallChangePercent > 0 ? "+" : ""}${overallChangePercent.toFixed(1)}% vs older sales cluster`;
  const overallLiquidity: "high" | "medium" | "low" =
    overallClean.length >= 15 ? "high" : overallClean.length >= 6 ? "medium" : "low";
  const overallHasBothClusters = overallRecentCluster.length >= 2 && overallOlderCluster.length >= 2;
  const overallTrendConfidence = parseFloat(
    Math.min(0.95, (Math.min(overallClean.length, 20) / 20) * 0.6 + (overallHasBothClusters ? 0.4 : 0.1)).toFixed(2),
  );
  const overallW7 = windowFilter(overallClean, 7, now);
  const overallW14 = windowFilter(overallClean, 14, now);
  const overallW30 = windowFilter(overallClean, 30, now);
  const overallW60 = windowFilter(overallClean, 60, now);
  const overallW90 = windowFilter(overallClean, 90, now);
  const overallTrend: TrendAnalysis = {
    market_direction: overallDirection,
    recent_sales_pattern: overallRecentPattern,
    older_sales_pattern: overallOlderPattern,
    change_from_older_to_recent: overallChangeDesc,
    liquidity: overallLiquidity,
    trend_confidence: overallTrendConfidence,
    windows: {
      last7: { count: overallW7.length, avgPrice: overallW7.length ? parseFloat(avgOf(overallW7.map((c) => c.price)).toFixed(2)) : null },
      last14: { count: overallW14.length, avgPrice: overallW14.length ? parseFloat(avgOf(overallW14.map((c) => c.price)).toFixed(2)) : null },
      last30: { count: overallW30.length, avgPrice: overallW30.length ? parseFloat(avgOf(overallW30.map((c) => c.price)).toFixed(2)) : null },
      last60: { count: overallW60.length, avgPrice: overallW60.length ? parseFloat(avgOf(overallW60.map((c) => c.price)).toFixed(2)) : null },
      last90: { count: overallW90.length, avgPrice: overallW90.length ? parseFloat(avgOf(overallW90.map((c) => c.price)).toFixed(2)) : null },
    },
  };

  summary += ` Overall market trend (${overallQuery}) is ${overallTrend.market_direction} (${overallTrend.change_from_older_to_recent}).`;

  const cleanByUrl = new Map(clean.map((c) => [c.url, c]));
  const recentComps = sorted
    .filter((c) => cleanByUrl.has(c.url))
    .slice(0, 10)
    .map((c) => ({
      ...c,
      normalizedPrice: cleanByUrl.get(c.url)?.price,
    }));

  return {
    success: true,
    query,
    summary,
    marketTier: { entry, fair, premium },
    buyZone,
    holdZone,
    sellZone,
    recentComps,
    outliers,
    trendAnalysis,
    supply: { activeListings: null, trend2w: null, trend4w: null, trend3m: null },
    confidence: displayConfidence,
    source: "live",
    valuationMethod: "trend-based",
    gradeTierUsed,
    marketTrendOverall: {
      queryUsed: overallQuery,
      sampleSize: overallClean.length,
      trend: overallTrend,
    },
  };
}
