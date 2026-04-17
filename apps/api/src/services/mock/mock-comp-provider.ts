import { CompIQInput, CompSale, SupplySnapshot } from '../../domain/compiq/compiq.types';

export interface CompProvider {
  getComps(input: CompIQInput): Promise<CompSale[]>;
  estimatePricing(input: CompIQInput): any;
  getPricingSignals(input: CompIQInput, fairMarketValue: number): string[];
  getBullets(input: CompIQInput, fairMarketValue: number): string[];
  getNextActions(input: CompIQInput, fairMarketValue: number): string[];
}

export class MockCompProvider implements CompProvider {
  async getComps(input: CompIQInput): Promise<CompSale[]> {
    return [
      { date: '2026-04-10', price: 120, grade: 'Raw', source: 'eBay', notes: 'Recent comp' },
      { date: '2026-04-08', price: 110, grade: 'Raw', source: 'eBay', notes: 'Recent comp' },
      { date: '2026-04-05', price: 130, grade: 'Raw', source: 'eBay', notes: 'Recent comp' }
    ];
  }
  estimatePricing(input: CompIQInput) {
    return {
      estimatedRaw: 120,
      estimatedPsa10: 300,
      estimatedPsa9: 180,
      estimatedPsa8: 140,
      fairMarketValue: 120,
      compRangeLow: 110,
      compRangeHigh: 130,
      buyTarget: 115
    };
  }
  getPricingSignals(input: CompIQInput, fairMarketValue: number): string[] {
    return ['Good Buy', 'Fair Price'];
  }
  getBullets(input: CompIQInput, fairMarketValue: number): string[] {
    return ['Recent comps support this price.', 'Market is stable.'];
  }
  getNextActions(input: CompIQInput, fairMarketValue: number): string[] {
    return ['Consider buying at or below target.', 'Monitor supply.'];
  }
}
