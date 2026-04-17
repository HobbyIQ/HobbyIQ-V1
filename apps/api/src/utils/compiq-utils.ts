import { CompIQInput, SupplySnapshot, MarketLadderTier } from '../domain/compiq/compiq.types';

export function normalizeParallel(parallel?: string): string {
  if (!parallel) return '';
  return parallel.trim().toUpperCase();
}

export function buildMarketLadder(input: CompIQInput, provider: any): MarketLadderTier[] {
  // Mock ladder
  return [
    { tier: 'Raw', price: 120 },
    { tier: 'PSA 9', price: 180 },
    { tier: 'PSA 10', price: 300 }
  ];
}

export function scoreConfidence(input: CompIQInput): number {
  // Simple confidence: more comps = higher confidence
  const count = input.recentComps?.length || 0;
  if (count >= 5) return 0.95;
  if (count >= 3) return 0.85;
  if (count >= 1) return 0.7;
  return 0.5;
}

export function interpretSupply(supply?: SupplySnapshot) {
  if (!supply) return { totalListed: 0, trend2w: 0, trend4w: 0, trend3m: 0, interpretation: 'No supply data.' };
  let interpretation = 'Stable';
  if (supply.trend2w > 10) interpretation = 'Supply rising';
  if (supply.trend2w < -10) interpretation = 'Supply dropping';
  return { ...supply, interpretation };
}
