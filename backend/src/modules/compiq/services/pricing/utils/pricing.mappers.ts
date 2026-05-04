// pricing.mappers.ts: helpers for mapping/weighting comps
import { NormalizedComp } from '../../../models/comp.types.js';

export function computeFinalCompWeight(comp: NormalizedComp, liquidityContextScore: number = 50): number {
  // Centralized, tunable weighting formula
  const weight =
    (comp.recencyScore ?? 0) * 0.15 +
    (comp.similarityScore ?? 0) * 0.20 +
    (comp.provenanceScore?.finalTrustScore ?? 0) * 0.15 +
    (comp.compStrengthScore ?? 0) * 0.15 +
    (comp.auctionQualityScore ?? 0) * 0.10 +
    (comp.timeToSellScore ?? 0) * 0.10 +
    (comp.listingQualityScore ?? 0) * 0.05 +
    liquidityContextScore * 0.10;
  // Normalize to 0-100
  return Math.max(0, Math.min(100, Math.round(weight)));
}
