import { VerdictEngine } from '../../src/modules/compiq/services/verdict/VerdictEngine.js';
import { expect } from 'chai';

describe('VerdictEngine', () => {
  it('returns Strong buy for high dealScore', () => {
    const result = VerdictEngine.generate({
      dealScore: 95,
      priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
      market: { marketSpeed: 'fast', marketPressure: 'buyers' },
      arbitrage: { signal: 'underpriced', mispricingDeltaPct: -0.1 },
      confidence: { pricingConfidence: 0.9, liquidityConfidence: 0.8, timingConfidence: 0.8 },
      marketDNA: { demand: 'high', liquidity: 'high', risk: 'medium', trend: 'up' }
    } as any);
    expect(result.action).to.equal('Buy');
    expect(result.verdict).to.match(/Strong buy/);
  });

  it('returns Hold for mid dealScore', () => {
    const result = VerdictEngine.generate({
      dealScore: 65,
      priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
      market: { marketSpeed: 'normal', marketPressure: 'balanced' },
      arbitrage: { signal: 'fair', mispricingDeltaPct: 0 },
      confidence: { pricingConfidence: 0.7, liquidityConfidence: 0.7, timingConfidence: 0.7 },
      marketDNA: { demand: 'medium', liquidity: 'medium', risk: 'medium', trend: 'flat' }
    } as any);
    expect(result.action).to.equal('Hold');
    expect(result.verdict).to.match(/Hold/);
  });

  it('returns Sell for low dealScore', () => {
    const result = VerdictEngine.generate({
      dealScore: 50,
      priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
      market: { marketSpeed: 'slow', marketPressure: 'sellers' },
      arbitrage: { signal: 'overpriced', mispricingDeltaPct: 0.2 },
      confidence: { pricingConfidence: 0.4, liquidityConfidence: 0.4, timingConfidence: 0.4 },
      marketDNA: { demand: 'low', liquidity: 'low', risk: 'high', trend: 'down' }
    } as any);
    expect(result.action).to.equal('Sell');
    expect(result.verdict).to.match(/Sell/);
  });

  it('returns Sell for very low dealScore with overpriced arbitrage', () => {
    const result = VerdictEngine.generate({
      dealScore: 30,
      priceLanes: { quickSaleValue: 100, fairMarketValue: 120, premiumValue: 140 },
      market: { marketSpeed: 'slow', marketPressure: 'sellers' },
      arbitrage: { signal: 'overpriced', mispricingDeltaPct: 0.3 },
      confidence: { pricingConfidence: 0.3, liquidityConfidence: 0.3, timingConfidence: 0.3 },
      marketDNA: { demand: 'low', liquidity: 'low', risk: 'high', trend: 'down' }
    } as any);
    expect(result.action).to.equal('Sell');
    expect(result.verdict).to.match(/Sell/);
  });
});
