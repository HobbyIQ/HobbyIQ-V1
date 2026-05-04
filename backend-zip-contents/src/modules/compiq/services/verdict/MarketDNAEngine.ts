// MarketDNAEngine: Generates simple market DNA labels

import { DynamicPricingResult } from '../../models/pricing.types.js';

export interface MarketDNALabels {
  demand: 'High' | 'Medium' | 'Low';
  speed: 'Fast' | 'Normal' | 'Slow';
  risk: 'Low' | 'Medium' | 'High';
  trend: 'Up' | 'Flat' | 'Down';
}

export class MarketDNAEngine {
  static generate(result: DynamicPricingResult): MarketDNALabels {
    const { marketDNA } = result;
    return {
      demand: marketDNA.demand === 'high' ? 'High' : marketDNA.demand === 'medium' ? 'Medium' : 'Low',
      speed: marketDNA.liquidity === 'high' ? 'Fast' : marketDNA.liquidity === 'medium' ? 'Normal' : 'Slow',
      risk: marketDNA.risk === 'high' ? 'High' : marketDNA.risk === 'medium' ? 'Medium' : 'Low',
      trend: marketDNA.trend === 'up' ? 'Up' : marketDNA.trend === 'down' ? 'Down' : 'Flat',
    };
  }
}
