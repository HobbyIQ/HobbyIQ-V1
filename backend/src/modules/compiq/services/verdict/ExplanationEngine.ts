// ExplanationEngine: Generates plain-English explanation bullets for CompIQ

import { DynamicPricingResult } from '../../models/pricing.types.js';

export class ExplanationEngine {
  static generate(result: DynamicPricingResult, askingPrice?: number): string[] {
    const bullets: string[] = [];
    const { market, marketDNA, priceLanes, dealScore, confidence, compSummary, alerts } = result;
    // Trend momentum
    if (marketDNA.trend === 'up') bullets.unshift('Recent sales are trending higher — prices are rising.');
    else if (marketDNA.trend === 'down') bullets.unshift('Recent sales are trending lower — prices are softening.');
    // Market speed
    if (market.marketSpeed === 'fast') bullets.push('Recent sales happened quickly.');
    else if (market.marketSpeed === 'slow') bullets.push('Market is moving slowly.');
    // Demand
    if (marketDNA.demand === 'high') bullets.push('There are not many listed right now.');
    else if (marketDNA.demand === 'low') bullets.push('Supply is high for this card.');
    // Price lanes
    if (dealScore >= 90) bullets.push('Similar cards are selling a little higher.');
    else if (dealScore < 60) bullets.push('This card may be overpriced.');
    // Risk
    if (marketDNA.risk === 'high') bullets.push('Risk is higher right now.');
    else if (marketDNA.risk === 'low') bullets.push('Risk is moderate right now.');
    // Confidence (0-100 scale)
    if (confidence.pricingConfidence > 80) bullets.push('Buyers still look active.');
    else if (confidence.pricingConfidence < 50) bullets.push('Confidence is lower due to limited data.');
    // Alerts
    if (alerts && alerts.length && bullets.length < 5) bullets.push(alerts[0]);
    // Clamp to 5 bullets
    return bullets.slice(0, 5);
  }
}
