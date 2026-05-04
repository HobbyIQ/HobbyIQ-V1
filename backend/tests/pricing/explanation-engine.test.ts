import { ExplanationEngine } from '../../src/modules/compiq/services/verdict/ExplanationEngine.js';
import { expect } from 'chai';

describe('ExplanationEngine', () => {
  it('generates fast market and high demand bullets', () => {
    const result = ExplanationEngine.generate({
      market: { marketSpeed: 'fast' },
      marketDNA: { demand: 'high', risk: 'medium' },
      dealScore: 95,
      priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
      confidence: { pricingConfidence: 0.9 },
      alerts: ['Test alert'],
      compSummary: ['c1', 'c2']
    } as any);
    expect(result).to.contain('Recent sales happened quickly.');
    expect(result).to.contain('There are not many listed right now.');
  });

  it('generates slow market and low demand bullets', () => {
    const result = ExplanationEngine.generate({
      market: { marketSpeed: 'slow' },
      marketDNA: { demand: 'low', risk: 'high' },
      dealScore: 40,
      priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
      confidence: { pricingConfidence: 0.4 },
      alerts: ['Test alert'],
      compSummary: ['c1', 'c2']
    } as any);
    expect(result).to.contain('Market is moving slowly.');
    expect(result).to.contain('Supply is high for this card.');
    expect(result).to.contain('This card may be overpriced.');
    expect(result).to.contain('Risk is higher right now.');
    expect(result).to.contain('Confidence is lower due to limited data.');
  });
});
