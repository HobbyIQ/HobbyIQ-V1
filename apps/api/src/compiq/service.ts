// --- Pure CompIQ runner ---
export interface RunCompIQResult {
  success: boolean;
  compsFound: boolean;
  median?: number;
  range?: { low: number; high: number };
  compCount?: number;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  latestPrice?: number;
  decision?: {
    signal: "BUY" | "HOLD" | "SELL";
    reason: string;
  };
  reason?: string;
}

export function runCompIQ(comps: Array<{
  title: string;
  price: number;
  date: Date | null;
  grade: string | null;
  isAuto: boolean;
  parallel: string;
}>): RunCompIQResult {
  // 1. Filter valid prices
  const validComps = comps.filter(c => typeof c.price === 'number' && c.price > 0);
  const compCount = validComps.length;
  if (compCount === 0) {
    return {
      success: true,
      compsFound: false,
      reason: "NO_VALID_PRICES"
    };
  }
  // 2. Sort prices ascending
  const prices = validComps.map(c => c.price).sort((a, b) => a - b);
  // 3. Calculate median, percentiles
  const median = ((): number => {
    if (compCount % 2 === 0) {
      return (prices[compCount / 2] + prices[compCount / 2 - 1]) / 2;
    } else {
      return prices[Math.floor(compCount / 2)];
    }
  })();
  const low = prices[Math.floor(compCount * 0.25)];
  const high = prices[Math.floor(compCount * 0.75)];
  const range = { low, high };
  // 5. Confidence
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";
  if (compCount >= 10) confidence = "HIGH";
  else if (compCount >= 5) confidence = "MEDIUM";
  // 6. Latest comp
  let latestComp = validComps[0];
  for (const c of validComps) {
    if (!latestComp.date && c.date) {
      latestComp = c;
    } else if (c.date && latestComp.date && new Date(c.date) > new Date(latestComp.date)) {
      latestComp = c;
    }
  }
  const latestPrice = latestComp.price;
  // 7. Decision logic
  let signal: "BUY" | "HOLD" | "SELL" = "HOLD";
  let reason = "At market";
  if (latestPrice < median * 0.85) {
    signal = "BUY";
    reason = "Below market";
  } else if (latestPrice > median * 1.15) {
    signal = "SELL";
    reason = "Above market";
  }

  // --- Segmentation ---
  const getMedian = (arr: number[]) => {
    const n = arr.length;
    if (n < 2) return undefined;
    if (n % 2 === 0) return (arr[n / 2] + arr[n / 2 - 1]) / 2;
    return arr[Math.floor(n / 2)];
  };
  const psa10 = validComps.filter(c => (c.grade || '').toLowerCase() === 'psa 10');
  const psa9 = validComps.filter(c => (c.grade || '').toLowerCase() === 'psa 9');
  const raw = validComps.filter(c => !c.grade || c.grade.toLowerCase() === 'raw');
  const auto = validComps.filter(c => c.isAuto === true);
  const nonAuto = validComps.filter(c => c.isAuto === false || c.isAuto === undefined);
  const segmentation: any = { grade: {}, auto: {} };
  const psa10Prices = psa10.map(c => c.price).sort((a, b) => a - b);
  const psa9Prices = psa9.map(c => c.price).sort((a, b) => a - b);
  const rawPrices = raw.map(c => c.price).sort((a, b) => a - b);
  const autoPrices = auto.map(c => c.price).sort((a, b) => a - b);
  const nonAutoPrices = nonAuto.map(c => c.price).sort((a, b) => a - b);
  const psa10Median = getMedian(psa10Prices);
  if (psa10Median !== undefined) segmentation.grade.psa10 = psa10Median;
  const psa9Median = getMedian(psa9Prices);
  if (psa9Median !== undefined) segmentation.grade.psa9 = psa9Median;
  const rawMedian = getMedian(rawPrices);
  if (rawMedian !== undefined) segmentation.grade.raw = rawMedian;
  const autoMedian = getMedian(autoPrices);
  if (autoMedian !== undefined) segmentation.auto.auto = autoMedian;
  const nonAutoMedian = getMedian(nonAutoPrices);
  if (nonAutoMedian !== undefined) segmentation.auto.nonAuto = nonAutoMedian;

  // --- Parallel Ladder ---
  const parallelNames = ["base", "refractor", "blue", "gold", "orange", "red"];
  const parallelLadder: Record<string, { median: number; count: number }> = {};
  for (const parallel of parallelNames) {
    const group = validComps.filter(c => (c.parallel || '').toLowerCase() === parallel);
    if (group.length >= 2) {
      const groupPrices = group.map(c => c.price).sort((a, b) => a - b);
      const n = groupPrices.length;
      let groupMedian: number;
      if (n % 2 === 0) {
        groupMedian = (groupPrices[n / 2] + groupPrices[n / 2 - 1]) / 2;
      } else {
        groupMedian = groupPrices[Math.floor(n / 2)];
      }
      parallelLadder[parallel] = { median: groupMedian, count: n };
    }
  }

  // --- Parallel Multipliers ---
  let baseRef: string | undefined = undefined;
  if (parallelLadder.base) baseRef = "base";
  else if (parallelLadder.refractor) baseRef = "refractor";
  const multipliers: Record<string, number> = {};
  if (baseRef) {
    const baseMedian = parallelLadder[baseRef].median;
    for (const key of Object.keys(parallelLadder)) {
      const group = parallelLadder[key];
      if (group && typeof group.median === 'number' && typeof baseMedian === 'number') {
        multipliers[key] = Math.round((group.median / baseMedian) * 100) / 100;
      }
    }
  }
  // Only include parallels where both that parallel and baseRef exist (already filtered above)
  // 10. Logging
  console.log("[runCompIQ] compCount:", compCount, "median:", median, "range:", range, "decision:", { signal, reason }, "segmentation:", segmentation, "parallelLadder:", parallelLadder, "multipliers:", multipliers);
  // --- Price Estimator Engine ---
  const estimates: Record<string, { raw: number; psa10?: number; psa9?: number }> = {};
  // Grade multipliers
  let psa10Multiplier: number | undefined = undefined;
  let psa9Multiplier: number | undefined = undefined;
  const rawMedian = segmentation?.grade?.raw;
  if (segmentation?.grade?.psa10 && rawMedian) {
    psa10Multiplier = segmentation.grade.psa10 / rawMedian;
  } else if (rawMedian) {
    psa10Multiplier = 2.25;
  }
  if (segmentation?.grade?.psa9 && rawMedian) {
    psa9Multiplier = segmentation.grade.psa9 / rawMedian;
  } else if (rawMedian) {
    psa9Multiplier = 1.15;
  }
  // For each parallel in multipliers
  for (const parallel of Object.keys(multipliers)) {
    const multiplier = multipliers[parallel];
    if (typeof multiplier !== 'number') continue;
    // 1. raw estimate
    const raw = Math.round(median * multiplier);
    const est: { raw: number; psa10?: number; psa9?: number } = { raw };
    // 2. psa10 estimate
    if (psa10Multiplier) {
      est.psa10 = Math.round(raw * psa10Multiplier);
    }
    // 3. psa9 estimate
    if (psa9Multiplier) {
      est.psa9 = Math.round(raw * psa9Multiplier);
    }
    estimates[parallel] = est;
  }
  // Always include base even if not in multipliers
  if (!estimates.base) {
    const est: { raw: number; psa10?: number; psa9?: number } = { raw: Math.round(median) };
    if (psa10Multiplier) est.psa10 = Math.round(median * psa10Multiplier);
    if (psa9Multiplier) est.psa9 = Math.round(median * psa9Multiplier);
    estimates.base = est;
  }
  // --- Negative Pressure (Downside Risk) Engine ---
  let riskScore = 50;
  const riskSignals: string[] = [];
  // 1. Price Trend
  const compsSortedByDate = [...validComps].filter(c => c.date).sort((a, b) => new Date(b.date as any).getTime() - new Date(a.date as any).getTime());
  if (compsSortedByDate.length >= 6) {
    const last3 = compsSortedByDate.slice(0, 3).map(c => c.price);
    const prev3 = compsSortedByDate.slice(3, 6).map(c => c.price);
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const last3Avg = avg(last3);
    const prev3Avg = avg(prev3);
    if (last3Avg < prev3Avg * 0.97) {
      riskScore += 20;
      riskSignals.push("Downward trend");
    } else if (last3Avg > prev3Avg * 1.03) {
      riskScore -= 15;
    }
  }
  // 2. Volatility
  if (median && range && (range.high - range.low) / median > 0.5) {
    riskScore += 15;
    riskSignals.push("High volatility");
  }
  // 3. Comp Count
  if (compCount < 5) {
    riskScore += 15;
    riskSignals.push("Low comp count");
  } else if (compCount > 10) {
    riskScore -= 10;
  }
  // 4. Recent Price Drop
  if (latestPrice < median * 0.8) {
    riskScore += 20;
    riskSignals.push("Recent price drop");
  }
  // Clamp score
  if (riskScore < 0) riskScore = 0;
  if (riskScore > 100) riskScore = 100;
  let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";
  if (riskScore <= 30) riskLevel = "LOW";
  else if (riskScore >= 71) riskLevel = "HIGH";
  const risk = {
    score: riskScore,
    level: riskLevel,
    signals: riskSignals
  };
  console.log("Risk Engine Output", risk);
  // Logging
  console.log("Estimator Output", estimates);
  // 8. Return object
  return {
    success: true,
    compsFound: true,
    median,
    range,
    compCount,
    confidence,
    latestPrice,
    decision: { signal, reason },
    segmentation,
    parallelLadder,
    multipliers,
    estimates,
    risk
  };
}
// --- CompIQ Decision Engine ---
export interface CompIQDecisionResult {
  decision: {
    signal: "BUY" | "HOLD" | "SELL";
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reasoning: string;
  }
}

/**
 * Decision engine using CompIQ pricing results
 * @param median median price from comps
 * @param latestPrice most recent comp price
 * @param confidence comp confidence ("HIGH" | "MEDIUM" | "LOW")
 * @param compTrend optional trend info (not used yet)
 */
export function compiqDecisionEngine({
  median,
  latestPrice,
  confidence,
  compTrend
}: {
  median: number;
  latestPrice: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  compTrend?: any;
}): CompIQDecisionResult {
  let signal: "BUY" | "HOLD" | "SELL" = "HOLD";
  let reasoning = "At market";
  if (latestPrice < median * 0.85) {
    signal = "BUY";
    reasoning = "Below market";
  } else if (latestPrice > median * 1.15) {
    signal = "SELL";
    reasoning = "Above market";
  }
  // Extendable: compTrend, other logic can be added here
  return {
    decision: {
      signal,
      confidence,
      reasoning
    }
  };
}
// --- CompIQ Pricing Engine ---
import { CompIQSoldListing } from "./types";

export interface CompIQPricingResult {
  success: boolean;
  compsFound: boolean;
  reason?: string;
  suggestion?: string;
  median?: number;
  range?: { low: number; high: number };
  compCount?: number;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  comps?: CompIQSoldListing[];
}

export function compiqPricingEngine(comps: CompIQSoldListing[]): CompIQPricingResult {
  if (!comps || comps.length === 0) {
    return {
      success: true,
      compsFound: false,
      reason: "NO_RESULTS",
      suggestion: "Try broader search or check dataset freshness"
    };
  }

  // Helper: get valid, sorted prices from comps
  const getSortedPrices = (arr: CompIQSoldListing[]) =>
    arr.map(c => c.price).filter(p => typeof p === 'number' && p > 0).sort((a, b) => a - b);

  // Helper: median
  const medianOf = (arr: number[]) => {
    const n = arr.length;
    if (n === 0) return undefined;
    if (n % 2 === 0) return (arr[n / 2] + arr[n / 2 - 1]) / 2;
    return arr[Math.floor(n / 2)];
  };


  // 1. Segment comps by grade and auto
  const psa10 = comps.filter(c => (c.grade || '').toLowerCase() === 'psa 10');
  const psa9 = comps.filter(c => (c.grade || '').toLowerCase() === 'psa 9');
  const raw = comps.filter(c => !c.grade || c.grade.toLowerCase() === 'raw');
  const auto = comps.filter(c => c.isAuto === true);
  const nonAuto = comps.filter(c => c.isAuto === false || c.isAuto === undefined);

  // 2. Compute medians for groups with at least 2 comps
  const segmentation: any = { grade: {}, auto: {} };
  const psa10Prices = getSortedPrices(psa10);
  if (psa10Prices.length >= 2) segmentation.grade.psa10Median = medianOf(psa10Prices);
  const psa9Prices = getSortedPrices(psa9);
  if (psa9Prices.length >= 2) segmentation.grade.psa9Median = medianOf(psa9Prices);
  const rawPrices = getSortedPrices(raw);
  if (rawPrices.length >= 2) segmentation.grade.rawMedian = medianOf(rawPrices);
  const autoPrices = getSortedPrices(auto);
  if (autoPrices.length >= 2) segmentation.auto.autoMedian = medianOf(autoPrices);
  const nonAutoPrices = getSortedPrices(nonAuto);
  if (nonAutoPrices.length >= 2) segmentation.auto.nonAutoMedian = medianOf(nonAutoPrices);

  // 3. Build parallel ladder (dynamic, at least 2 comps per parallel)
  const parallelLadder: Record<string, { median: number, count: number }> = {};
  const parallelGroups: Record<string, CompIQSoldListing[]> = {};
  for (const comp of comps) {
    const parallel = (comp.parallel || '').toLowerCase();
    if (!parallel) continue;
    if (!parallelGroups[parallel]) parallelGroups[parallel] = [];
    parallelGroups[parallel].push(comp);
  }
  for (const [parallel, group] of Object.entries(parallelGroups)) {
    const prices = getSortedPrices(group);
    if (prices.length >= 2) {
      parallelLadder[parallel] = {
        median: medianOf(prices)!,
        count: prices.length
      };
    }
  }

  // 3. Main pricing engine (all comps)
  const prices = getSortedPrices(comps);
  const compCount = prices.length;
  if (compCount === 0) {
    return {
      success: true,
      compsFound: false,
      reason: "NO_RESULTS",
      suggestion: "Try broader search or check dataset freshness"
    };
  }
  let median: number = medianOf(prices)!;
  const low = prices[Math.floor(compCount * 0.25)];
  const high = prices[Math.floor(compCount * 0.75)];
  const range = { low, high };
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "LOW";
  if (compCount >= 10) confidence = "HIGH";
  else if (compCount >= 5) confidence = "MEDIUM";
  // Logging
  console.log("[CompIQ Pricing] comps:", compCount, "median:", median, "range:", range, "segmentation:", segmentation, "parallelLadder:", parallelLadder);
  // Return
  return {
    success: true,
    compsFound: true,
    median,
    range,
    compCount,
    confidence,
    comps,
    segmentation,
    parallelLadder
  };
}
// Helper: weighted median (local copy)
function weightedMedian(values: number[], weights: number[]): number | null {
  if (!values.length) return null;
  const sorted = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);
  let total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const { v, w } of sorted) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return sorted[sorted.length - 1].v;
}

// Helper: filter outliers (basic IQR filter)
function filterOutliers(comps: CompIQSoldListing[]): CompIQSoldListing[] {
  if (comps.length < 4) return comps;
  const prices = comps.map((c: CompIQSoldListing) => c.soldPrice);
  const sorted = [...prices].sort((a: number, b: number) => a - b);
  const q1 = sorted[Math.floor(sorted.length / 4)];
  const q3 = sorted[Math.floor(sorted.length * 3 / 4)];
  const iqr = q3 - q1;
  const min = q1 - 1.5 * iqr;
  const max = q3 + 1.5 * iqr;
  return comps.filter((c: CompIQSoldListing) => c.soldPrice >= min && c.soldPrice <= max);
}
import { CompIQFetchParams, CompIQSoldListing, CompIQMarketStats } from "./types";
import { fetchSoldListingsFromApify } from "./apify";

// --- Normalization helpers ---
function extractGrade(title: string): string | undefined {
  const match = title.match(/PSA ?(\d+)/i);
  return match ? `PSA ${match[1]}` : undefined;
}
function extractParallel(title: string): string | undefined {
  // Example: look for "gold", "blue shimmer", etc.
  const match = title.match(/(gold|blue shimmer|green|orange|red|purple|refractor|wave|mojo|cracked ice|atomic|black|pink|yellow|rainbow|silver|bronze|camo|sepia|aqua|fuchsia|teal|sapphire|platinum|chrome|prizm|optic|hyper|lava|speckle|mini-diamond|true gold|true blue|true red|true orange|true green|true purple|true black|true pink|true yellow|true rainbow|true silver|true bronze|true camo|true sepia|true aqua|true fuchsia|true teal|true sapphire|true platinum)/i);
  return match ? match[1] : undefined;
}

// Main CompIQ service: fetch, normalize, filter comps
export async function getCompIQComps(params: CompIQFetchParams): Promise<CompIQSoldListing[]> {
  try {
    const results = await fetchSoldListingsFromApify(params);
    if (!results || results.length === 0) {
      return Object.assign([], {
        _noComps: true,
        _noCompsReason: "NO_RESULTS",
        _noCompsSuggestion: "Try broader search or check dataset freshness"
      });
    }
    // Normalize
    const normalized = results.map(item => ({
      title: item.title,
      price: parseFloat((item.price || item.soldPrice || '').toString().replace(/[^\d.]/g, "")) || 0,
      date: item.date ? new Date(item.date) : (item.soldDate ? new Date(item.soldDate) : undefined),
      grade: extractGrade(item.title),
      isAuto: item.title.toLowerCase().includes("auto"),
      parallel: extractParallel(item.title),
    })).filter(c => c.price > 0 && c.date);
    // Median & range
    const prices = normalized.map(c => c.price).filter(p => p > 0).sort((a, b) => a - b);
    let median = null, low = null, high = null;
    if (prices.length) {
      median = prices.length % 2 === 0
        ? (prices[prices.length / 2] + prices[prices.length / 2 - 1]) / 2
        : prices[Math.floor(prices.length / 2)];
      low = prices[Math.floor(prices.length * 0.25)];
      high = prices[Math.floor(prices.length * 0.75)];
    }
    // Confidence
    const confidence = prices.length >= 10 ? "HIGH" : prices.length >= 5 ? "MEDIUM" : "LOW";
    return Object.assign(normalized, {
      _pricing: { median, range: { low, high }, compCount: prices.length, confidence }
    });
  } catch (err: any) {
    if (err && err.message && (err.message.includes("404") || err.message.includes("dataset"))) {
      return Object.assign([], {
        _fetchError: true,
        _fetchErrorMessage: "Apify dataset not found or not ready",
        _fetchErrorType: "DATASET_ERROR"
      });
    }
    console.error('[CompIQ] Fetch error:', err && err.message ? err.message : err);
    return Object.assign([], { _fetchError: true, _fetchErrorMessage: err && err.message ? err.message : String(err) });
  }
}

// Helper: recency weight (favor recent sales)
function recencyWeight(soldDate: string): number {
  const days = (Date.now() - new Date(soldDate).getTime()) / (1000 * 60 * 60 * 24);
  if (days < 0) return 1;
  if (days < 7) return 1.5;
  if (days < 30) return 1.2;
  if (days < 90) return 1.0;
  if (days < 180) return 0.7;
  if (days < 365) return 0.5;
  return 0.3;
}

// Main market stats calculation
export function calculateCompIQMarketStats(comps: CompIQSoldListing[]): CompIQMarketStats {
  if (!comps.length) {
    return {
      fmv: null,
      low: null,
      high: null,
      trend: null,
      liquidity: null,
      compCount: 0,
      confidence: 0,
      compsUsed: [],
    };
  }
  // 1. Outlier filter
  const filtered: CompIQSoldListing[] = filterOutliers(comps);
  // 2. Recency weights
  const weights: number[] = filtered.map((c: CompIQSoldListing) => recencyWeight(c.soldDate));
  // 3. FMV (weighted median)
  const prices: number[] = filtered.map((c: CompIQSoldListing) => c.soldPrice);
  const fmv: number | null = weightedMedian(prices, weights);
  // 4. Range
  const low: number = Math.min(...prices);
  const high: number = Math.max(...prices);
  // 5. Trend (recency-weighted linear regression slope)
  let trend: number | null = null;
  if (filtered.length > 2) {
    // x = days ago, y = price
    const xs: number[] = filtered.map((c: CompIQSoldListing) => (Date.now() - new Date(c.soldDate).getTime()) / (1000 * 60 * 60 * 24));
    const ys: number[] = prices;
    const wsum: number = weights.reduce((a: number, b: number) => a + b, 0);
    const xbar: number = xs.reduce((a: number, b: number, i: number) => a + b * weights[i], 0) / wsum;
    const ybar: number = ys.reduce((a: number, b: number, i: number) => a + b * weights[i], 0) / wsum;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += weights[i] * (xs[i] - xbar) * (ys[i] - ybar);
      den += weights[i] * (xs[i] - xbar) ** 2;
    }
    trend = den ? -num / den : 0; // negative slope = price rising
  }
  // 6. Liquidity (sales per 30 days)
  const now: number = Date.now();
  const days: number[] = filtered.map((c: CompIQSoldListing) => (now - new Date(c.soldDate).getTime()) / (1000 * 60 * 60 * 24));
  const within30: number = days.filter((d: number) => d <= 30).length;
  const liquidity: number = within30;
  // 7. Comp count
  const compCount: number = filtered.length;
  // 8. Confidence (simple: comp count, recency, variance, completeness)
  let confidence: number = 0;
  if (compCount >= 8) confidence += 40;
  else if (compCount >= 4) confidence += 25;
  else if (compCount >= 2) confidence += 10;
  // Recency: more recent = higher
  const avgDays: number = days.reduce((a: number, b: number) => a + b, 0) / compCount;
  if (avgDays < 14) confidence += 30;
  else if (avgDays < 60) confidence += 15;
  // Variance: lower = higher confidence
  const mean: number = prices.reduce((a: number, b: number) => a + b, 0) / compCount;
  const variance: number = prices.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / compCount;
  if (variance < 0.1 * mean ** 2) confidence += 20;
  else if (variance < 0.2 * mean ** 2) confidence += 10;
  // Data completeness
  if (filtered.every((c: CompIQSoldListing) => c.soldDate && c.soldPrice && c.title)) confidence += 10;
  if (confidence > 100) confidence = 100;
  // 9. Return
  return {
    fmv,
    low,
    high,
    trend,
    liquidity,
    compCount,
    confidence,
    compsUsed: filtered,
  };
}
