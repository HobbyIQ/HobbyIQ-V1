// MarketDNAEngine

export class MarketDNAEngine {
  static classify(demand: number, liquidity: number, risk: number, trend: 'up' | 'flat' | 'down') {
    const tag = (v: number) => v > 70 ? 'high' : v > 40 ? 'medium' : 'low';
    return {
      demand: tag(demand) as 'high' | 'medium' | 'low',
      liquidity: tag(liquidity) as 'high' | 'medium' | 'low',
      risk: tag(100 - risk) as 'high' | 'medium' | 'low',
      trend
    };
  }
}
