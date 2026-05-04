// VerdictEngine: Compresses pricing signals into a plain-English verdict and action

import { DynamicPricingResult } from '../../models/pricing.types.js';

export type VerdictAction = 'Buy' | 'Hold' | 'Sell' | 'Pass';

export interface VerdictOutput {
  verdict: string;
  action: VerdictAction;
}

export class VerdictEngine {
  static generate(result: DynamicPricingResult, askingPrice?: number): VerdictOutput {
    const { dealScore, priceLanes, market, arbitrage, confidence, marketDNA } = result;
    // Action logic
    let action: VerdictAction = 'Hold';
    if (dealScore >= 90) action = 'Buy';
    else if (dealScore >= 75) action = 'Buy';
    else if (dealScore >= 60) action = 'Hold';
    else if (dealScore >= 45) action = 'Sell';
    else action = 'Pass';
    // Arbitrage/price override
    if (arbitrage.signal === 'underpriced' && dealScore >= 75) action = 'Buy';
    if (arbitrage.signal === 'overpriced' && dealScore < 60) action = 'Sell';
    if (askingPrice && askingPrice > priceLanes.premiumValue * 1.1) action = 'Pass';
    // Verdict sentence
    let verdict = '';
    if (dealScore >= 90) {
      verdict = 'Strong buy — priced below market and demand is moving fast.';
    } else if (action === 'Sell') {
      verdict = 'Sell — supply is rising and the market is slowing.';
    } else if (action === 'Buy') {
      verdict = 'Buy — good value and market signals are positive.';
    } else if (action === 'Hold') {
      verdict = 'Hold — fair value, but momentum is improving.';
    } else {
      verdict = 'Pass — too expensive for the current risk.';
    }
    return { verdict, action };
  }
}
