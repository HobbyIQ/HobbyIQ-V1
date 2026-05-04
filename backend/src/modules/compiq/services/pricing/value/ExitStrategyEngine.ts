// ExitStrategyEngine

export class ExitStrategyEngine {
  static recommend(liquidity: number, marketSpeed: 'fast' | 'normal' | 'slow'): {
    recommendedMethod: 'auction' | 'bin';
    expectedDaysToSell: number | null;
    timingRecommendation: string;
    reasoning: string[];
  } {
    let recommendedMethod: 'auction' | 'bin' = 'bin';
    let expectedDaysToSell: number | null = null;
    let timingRecommendation: string = 'Hold and monitor the market.';
    const reasoning: string[] = [];
    if (liquidity > 70 && marketSpeed === 'fast') {
      recommendedMethod = 'auction';
      expectedDaysToSell = 3;
      timingRecommendation = 'List at auction now — demand is high and the market is moving fast.';
      reasoning.push('High liquidity and fast market');
    } else if (liquidity > 50) {
      recommendedMethod = 'auction';
      expectedDaysToSell = 7;
      timingRecommendation = 'List at auction within the next few days.';
      reasoning.push('Moderate liquidity, auction preferred');
    } else {
      recommendedMethod = 'bin';
      expectedDaysToSell = 14;
      timingRecommendation = 'Set a fixed price and wait for the right buyer.';
      reasoning.push('Low liquidity, BIN safer');
    }
    return { recommendedMethod, expectedDaysToSell, timingRecommendation, reasoning };
  }
}
