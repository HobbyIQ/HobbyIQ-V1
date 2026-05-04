import { DynamicPricingOrchestrator } from '../../src/modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js';
import { CardSubject } from '../../src/modules/compiq/models/pricing.types.js';
import { CompInput } from '../../src/modules/compiq/models/comp.types.js';
import { expect } from 'chai';
// import { MarketContext } from '../../src/modules/compiq/models/intelligence.types';

describe('Pipeline fallbacks', () => {
  it('returns fallback for empty comps', () => {
    const subject: CardSubject = { playerName: 'T', setName: 'S', cardYear: 2020 };
    const comps: CompInput[] = [];
    const context: any = { marketIndexTrend: 0, volatilityIndex: 50 };
    const result = DynamicPricingOrchestrator.run(subject, comps, context, true);
    expect(result.priceLanes.fairMarketValue).to.equal(0);
    expect(result.observability.usedFallback).to.be.true;
    expect(result.observability.fallbackReason).to.not.be.undefined;
  });

  it('returns fallback for all rejected comps', () => {
    // Simulate all comps rejected by setting a rejectionReason
    const subject: CardSubject = { playerName: 'T', setName: 'S', cardYear: 2020 };
    const comps: CompInput[] = [
      { price: 0, date: '2024-01-01', source: 'ebay' }
    ];
    const context: any = { marketIndexTrend: 0, volatilityIndex: 50 };
    const result = DynamicPricingOrchestrator.run(subject, comps, context, true);
    expect(result.priceLanes.fairMarketValue).to.equal(0);
    expect(result.observability.usedFallback).to.be.true;
  });
});
