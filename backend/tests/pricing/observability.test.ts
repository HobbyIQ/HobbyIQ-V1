import { DynamicPricingOrchestrator } from '../../src/modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js';
import { CardSubject } from '../../src/modules/compiq/models/pricing.types.js';
import { CompInput } from '../../src/modules/compiq/models/comp.types.js';
import { expect } from 'chai';
// import { MarketContext } from '../../src/modules/compiq/models/intelligence.types';

describe('Observability snapshot', () => {
  it('flags sparse data and fallback', () => {
    const subject: CardSubject = { playerName: 'Test Player', setName: 'Test Set', cardYear: 2020 };
    const comps: CompInput[] = [];
    const context: any = { marketIndexTrend: 0, volatilityIndex: 50 };
    const result = DynamicPricingOrchestrator.run(subject, comps, context, true);
    expect(result.observability.usedFallback).to.be.true;
    expect(result.observability.sparseDataFlag).to.be.true;
  });

  it('flags non-sparse data', () => {
    const subject: CardSubject = { playerName: 'Test Player', setName: 'Test Set', cardYear: 2020 };
    const comps: CompInput[] = [
      { price: 100, date: '2024-01-01', source: 'ebay' },
      { price: 120, date: '2024-01-02', source: 'ebay' },
      { price: 110, date: '2024-01-03', source: 'ebay' },
      { price: 130, date: '2024-01-04', source: 'ebay' }
    ];
    const context: any = { marketIndexTrend: 1, volatilityIndex: 30 };
    const result = DynamicPricingOrchestrator.run(subject, comps, context, true);
    expect(result.observability.usedFallback).to.be.false;
    expect(result.observability.sparseDataFlag).to.be.false;
  });
});
