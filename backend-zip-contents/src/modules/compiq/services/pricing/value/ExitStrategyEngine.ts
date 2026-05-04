// ExitStrategyEngine

export class ExitStrategyEngine {
  static recommend(liquidity: number, marketSpeed: 'fast' | 'normal' | 'slow'): {
    recommendedMethod: 'auction' | 'bin';
    expectedDaysToSell: number | null;
    timingRecommendation: 'sell_now' | 'hold' | 'list_high_and_wait' | 'auction_now';
    reasoning: string[];
  } {
    let recommendedMethod: 'auction' | 'bin' = 'bin';
    let expectedDaysToSell: number | null = null;
    let timingRecommendation: 'sell_now' | 'hold' | 'list_high_and_wait' | 'auction_now' = 'hold';
    const reasoning: string[] = [];
    if (liquidity > 70 && marketSpeed === 'fast') {
      recommendedMethod = 'auction';
      expectedDaysToSell = 3;
      timingRecommendation = 'sell_now';
      reasoning.push('High liquidity and fast market');
    } else if (liquidity > 50) {
      recommendedMethod = 'auction';
      expectedDaysToSell = 7;
      timingRecommendation = 'auction_now';
      reasoning.push('Moderate liquidity, auction preferred');
    } else {
      recommendedMethod = 'bin';
      expectedDaysToSell = 14;
      timingRecommendation = 'list_high_and_wait';
      reasoning.push('Low liquidity, BIN safer');
    }
    return { recommendedMethod, expectedDaysToSell, timingRecommendation, reasoning };
  }
}
