import type { NormalizedComp, FmvSummary, GradeBucket } from "../../types/comps";
import { filterExactMatches } from "./exactMatch";
import type { ExactMatchOptions } from "./exactMatch";
import { InMemoryCache } from "./cache";
import { pricingSnapshotRepository } from "../../repositories/pricingSnapshotRepository";
import { modelWeightProfileRepository } from "../../repositories/modelWeightProfileRepository";
import type { ModelWeightProfile } from "../../types/learning";

// Remove outliers using IQR (interquartile range)
function removeOutliers(comps: NormalizedComp[]): NormalizedComp[] {
  const prices = comps.map(c => c.totalPrice).sort((a, b) => a - b);
  if (prices.length < 4) return comps;
  const q1 = prices[Math.floor(prices.length / 4)];
  const q3 = prices[Math.floor(prices.length * 3 / 4)];
  if (q1 === undefined || q3 === undefined) return comps;
  const iqr = q3 - q1;
  const min = q1 - 1.5 * iqr;
  const max = q3 + 1.5 * iqr;
  return comps.filter(c => c.totalPrice >= min && c.totalPrice <= max);
}

// Weighted median: weights by recency and matchScore
function weightedMedian(comps: NormalizedComp[]): number {
  if (!comps.length) return 0;
  const now = Date.now();
  // Assign weights: newer = higher, higher matchScore = higher
  const weighted = comps.map(c => {
    const daysAgo = Math.max(1, (now - new Date(c.soldDate || "").getTime()) / 86400000);
    const recencyWeight = 1 / daysAgo;
    const matchWeight = (c.matchScore ?? 50) / 100;
    return { price: c.totalPrice, weight: recencyWeight * (0.7 + 0.3 * matchWeight) };
  });
  weighted.sort((a, b) => a.price - b.price);
  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let acc = 0;
  for (const w of weighted) {
    acc += w.weight;
    if (acc >= totalWeight / 2) return w.price;
  }
  return weighted[weighted.length - 1]?.price ?? 0;
}

/**
 * Score confidence 0-100 based on comp count, matchScore, recency, and grade consistency.
 */
// Refactored: Confidence scoring with more factors and details
export interface ConfidenceDetails {
  score: number;
  compCount: number;
  avgMatch: number;
  avgRecency: number;
  gradeConsistency: number;
  parallelConsistency: number;
}
function scoreConfidence(comps: NormalizedComp[], bucketLabel?: string): ConfidenceDetails {
  if (!comps.length) return { score: 0, compCount: 0, avgMatch: 0, avgRecency: 0, gradeConsistency: 0, parallelConsistency: 0 };
  const count = comps.length;
  const avgMatch = comps.reduce((sum, c) => sum + (c.matchScore ?? 50), 0) / count;
  const now = Date.now();
  const avgRecency = comps.reduce((sum, c) => {
    const daysAgo = c.soldDate ? Math.max(1, (now - new Date(c.soldDate).getTime()) / 86400000) : 30;
    return sum + daysAgo;
  }, 0) / count;
  let gradeConsistency = 100;
  if (bucketLabel && bucketLabel !== "OTHER") {
    gradeConsistency = comps.every(c => (c.grade || "RAW").toUpperCase() === bucketLabel) ? 100 : 70;
  }
  // Parallel consistency: all comps have same parallel (or all null)
  let parallelConsistency = 100;
  const firstParallel = comps[0]?.parallel || null;
  if (!comps.every(c => (c.parallel || null) === firstParallel)) parallelConsistency = 70;
  // Confidence: count (max 40), match (max 100), recency (best <14 days), grade (max 100), parallel (max 100)
  let conf = 0.4 * Math.min(100, (count / 40) * 100)
    + 0.2 * avgMatch
    + 0.15 * Math.max(0, 100 - Math.min(100, (avgRecency - 7) * 5))
    + 0.15 * gradeConsistency
    + 0.1 * parallelConsistency;
  if (count < 4) conf *= 0.7;
  const score = Math.round(Math.max(10, Math.min(100, conf)));
  return { score, compCount: count, avgMatch, avgRecency, gradeConsistency, parallelConsistency };
}

/**
 * Bucket comps by grade: RAW, PSA 9, PSA 10, OTHER.
 */
function bucketByGrade(comps: NormalizedComp[]): Record<string, NormalizedComp[]> {
  const buckets: Record<string, NormalizedComp[]> = {
    RAW: [],
    "PSA 9": [],
    "PSA 10": [],
    OTHER: [],
  };
  for (const c of comps) {
    const grade = (c.grade || "").toUpperCase();
    if (!grade || grade === "RAW") buckets.RAW?.push?.(c);
    else if (grade === "PSA 9") buckets["PSA 9"]?.push?.(c);
    else if (grade === "PSA 10") buckets["PSA 10"]?.push?.(c);
    else buckets.OTHER?.push?.(c);
  }
  return buckets;
}

/**
 * Calculate FMV summary and grade buckets for comps.
 */
export function calculateFmv(
  comps: NormalizedComp[],
  exactMatchOpts?: ExactMatchOptions,
  opts?: {
    cardId?: string;
    playerId?: string;
    marketSegment?: string;
    recommendation?: string;
    mockMode?: boolean;
  }
): { summary: FmvSummary; buckets: GradeBucket[] } {
  // 1. Filter invalid comps
  let usable = comps.filter(c => c && typeof c.totalPrice === "number" && c.totalPrice > 0);
  // 2. Apply exact-match filtering if options provided
  if (exactMatchOpts) {
    usable = filterExactMatches(usable, exactMatchOpts);
  }
  if (!usable.length) {
    return {
      summary: {
        fmv: 0,
        low: 0,
        high: 0,
        compCount: 0,
        confidence: "Low",
      },
      buckets: [],
    };
  }

  // 3. Sort by recency
  usable.sort((a, b) => {
    const da = a.soldDate ? new Date(a.soldDate).getTime() : 0;
    const db = b.soldDate ? new Date(b.soldDate).getTime() : 0;
    return db - da;
  });

  // 4. Remove outliers
  const filtered = removeOutliers(usable);

  // 4. Weighted median FMV
  const fmv = Math.round(weightedMedian(filtered));

  // 5. Range (trimmed min/max)
  const sorted = filtered.slice().sort((a, b) => a.totalPrice - b.totalPrice);
  const trim = Math.max(1, Math.floor(sorted.length * 0.1));
  const trimmed = sorted.slice(trim, sorted.length - trim);
  let low = 0;
  let high = 0;
  if (trimmed.length > 0 && Array.isArray(trimmed)) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first && typeof first.totalPrice === 'number') low = Math.round(first.totalPrice);
    if (last && typeof last.totalPrice === 'number') high = Math.round(last.totalPrice);
  } else if (sorted.length > 0 && Array.isArray(sorted)) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first && typeof first.totalPrice === 'number') low = Math.round(first.totalPrice);
    if (last && typeof last.totalPrice === 'number') high = Math.round(last.totalPrice);
  }

  // 6. Confidence
  const confidenceDetails = scoreConfidence(filtered);
  const confidenceScore = confidenceDetails.score;

  // 7. Buckets
  const gradeBuckets = bucketByGrade(filtered);
  const buckets: GradeBucket[] = [];
  for (const label of ["RAW", "PSA 9", "PSA 10", "OTHER"]) {
    const bucket = gradeBuckets[label];
    if (bucket && bucket.length) {
      const bucketFiltered = removeOutliers(bucket);
      const bucketFmv = Math.round(weightedMedian(bucketFiltered));
      const bucketSorted = bucketFiltered.slice().sort((a, b) => a.totalPrice - b.totalPrice);
      const bucketTrim = Math.max(1, Math.floor(bucketSorted.length * 0.1));
      const bucketTrimmed = bucketSorted.slice(bucketTrim, bucketSorted.length - bucketTrim);
      let bucketLow = 0;
      let bucketHigh = 0;
      if (bucketTrimmed.length > 0 && Array.isArray(bucketTrimmed)) {
        const first = bucketTrimmed[0];
        const last = bucketTrimmed[bucketTrimmed.length - 1];
        if (first && typeof first.totalPrice === 'number') bucketLow = Math.round(first.totalPrice);
        if (last && typeof last.totalPrice === 'number') bucketHigh = Math.round(last.totalPrice);
      } else if (bucketSorted.length > 0 && Array.isArray(bucketSorted)) {
        const first = bucketSorted[0];
        const last = bucketSorted[bucketSorted.length - 1];
        if (first && typeof first.totalPrice === 'number') bucketLow = Math.round(first.totalPrice);
        if (last && typeof last.totalPrice === 'number') bucketHigh = Math.round(last.totalPrice);
      }
      buckets.push({
        label,
        compCount: bucket.length,
        fmv: bucketFmv,
        low: bucketLow,
        high: bucketHigh,
      });
    }
  }

  // 8. Save pricing snapshot (learning layer integration)
  if (opts && opts.cardId && opts.playerId && opts.marketSegment && !opts.mockMode) {
    // Get active weight profile for segment
    let weightsUsed: ModelWeightProfile | undefined = modelWeightProfileRepository.getActiveBySegment(opts.marketSegment);
    if (!weightsUsed) {
      // fallback: use any profile for segment
      const all = modelWeightProfileRepository.getBySegment(opts.marketSegment);
      if (all && all.length) weightsUsed = all[0];
    }
    pricingSnapshotRepository.add({
      cardId: opts.cardId,
      playerId: opts.playerId,
      marketSegment: opts.marketSegment,
      fmvEstimate: fmv,
      buyTarget: Math.round(fmv * 0.85),
      sellTarget: Math.round(fmv * 1.15),
      confidenceScore,
      compSet: filtered.map(c => c.sourceUrl || c.title),
      weightsUsed: weightsUsed || { id: "mock", marketSegment: opts.marketSegment, weights: {}, version: "mock", createdAt: new Date().toISOString(), approved: false },
      recommendation: opts.recommendation || "",
      createdAt: new Date().toISOString(),
    });
  }
  // 9. Return
  return {
    summary: {
      fmv,
      low,
      high,
      compCount: filtered.length,
      confidence: confidenceScore >= 80 ? "High" : confidenceScore >= 50 ? "Medium" : "Low",
      confidenceDetails,
    },
    buckets,
  };
}
// ...existing code...
