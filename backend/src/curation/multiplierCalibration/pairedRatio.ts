// CF-CAT-ENGINE (2026-06-21): per-card paired-ratio computation. Given a
// per-card sales pool, computes the within-card paired ratio between a
// target tier and a reference (base-auto or Refractor /499).
//
// "Paired" means same card: numerator and denominator are both from the
// same player's listing pool. This sidesteps the tier-distribution
// distortion that cross-card medians import (CF-X2-ANCHOR's load-bearing
// methodological finding).

import { classifySale, isBaseAutoTitle, type ClassifiedSale } from "./saleClassifier.js";

export interface CardSale {
  price: number;
  title: string;
}

export interface PerCardSales {
  cardId: string;
  playerName: string;
  sales: ReadonlyArray<CardSale>;
}

export interface PerCardBuckets {
  cardId: string;
  playerName: string;
  baseAutos: number[];
  ref499: number[];
  /** Map<tierKey, prices[]>. Excludes base-auto and Ref/499 — those have their own slots. */
  tiers: Map<string, number[]>;
}

export interface PairedRatio {
  cardId: string;
  playerName: string;
  numeratorMedian: number;
  numeratorN: number;
  denominatorMedian: number;
  denominatorN: number;
  ratio: number;
}

export type PairedBasis = "base-auto" | "ref-499";

export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 25th, 50th, 75th percentiles via linear interpolation. */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

/** Bucket a card's sales by parallel-tier identity. */
export function bucketCardSales(card: PerCardSales): PerCardBuckets {
  const buckets: PerCardBuckets = {
    cardId: card.cardId,
    playerName: card.playerName,
    baseAutos: [],
    ref499: [],
    tiers: new Map(),
  };
  for (const sale of card.sales) {
    const price = Number(sale.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const cls = classifySale(sale.title);
    if (!cls.isAutograph) continue;
    if (cls.isBaseAuto) {
      buckets.baseAutos.push(price);
      continue;
    }
    if (cls.parallelName === "Refractor" && cls.printRun === 499) {
      buckets.ref499.push(price);
      continue;
    }
    if (cls.tierKey === "unclassified" || cls.tierKey === "base-auto") continue;
    const arr = buckets.tiers.get(cls.tierKey) ?? [];
    arr.push(price);
    buckets.tiers.set(cls.tierKey, arr);
  }
  return buckets;
}

/**
 * Strict-paired set: cards with ≥2 sales of BOTH the target tier and the
 * basis (base-auto or Ref/499). Returns per-card ratios.
 */
export function pairedRatiosStrict(
  perCard: ReadonlyArray<PerCardBuckets>,
  tierKey: string,
  basis: PairedBasis,
): PairedRatio[] {
  const results: PairedRatio[] = [];
  for (const card of perCard) {
    const tierPrices = card.tiers.get(tierKey) ?? [];
    const basisPrices = basis === "base-auto" ? card.baseAutos : card.ref499;
    if (tierPrices.length < 2 || basisPrices.length < 2) continue;
    const num = median(tierPrices)!;
    const den = median(basisPrices)!;
    if (den <= 0) continue;
    results.push({
      cardId: card.cardId,
      playerName: card.playerName,
      numeratorMedian: num,
      numeratorN: tierPrices.length,
      denominatorMedian: den,
      denominatorN: basisPrices.length,
      ratio: num / den,
    });
  }
  return results.sort((a, b) => a.ratio - b.ratio);
}

/**
 * Relaxed-paired set: cards with ≥1 sale of BOTH. Wider sample, more noise.
 * The engine uses strict for the n-gate and centerpoint, relaxed for the
 * honest spread (IQR).
 */
export function pairedRatiosRelaxed(
  perCard: ReadonlyArray<PerCardBuckets>,
  tierKey: string,
  basis: PairedBasis,
): PairedRatio[] {
  const results: PairedRatio[] = [];
  for (const card of perCard) {
    const tierPrices = card.tiers.get(tierKey) ?? [];
    const basisPrices = basis === "base-auto" ? card.baseAutos : card.ref499;
    if (tierPrices.length < 1 || basisPrices.length < 1) continue;
    const num = median(tierPrices)!;
    const den = median(basisPrices)!;
    if (den <= 0) continue;
    results.push({
      cardId: card.cardId,
      playerName: card.playerName,
      numeratorMedian: num,
      numeratorN: tierPrices.length,
      denominatorMedian: den,
      denominatorN: basisPrices.length,
      ratio: num / den,
    });
  }
  return results.sort((a, b) => a.ratio - b.ratio);
}

export { isBaseAutoTitle };
export type { ClassifiedSale };
