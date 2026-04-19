// Types and interfaces for the compiq pricing engine

export type PricingMode = 'direct_comp' | 'hybrid' | 'parallel_inference' | 'low_data';
export type Liquidity = 'high' | 'medium' | 'low' | 'illiquid';
export type Trend = 'strong_up' | 'mild_up' | 'flat' | 'mild_down' | 'strong_down';

export interface Comp {
  id: string;
  player: string;
  product: string;
  cardNumber: string;
  parallel: string;
  auto?: boolean;
  grade?: string;
  saleDate: string; // ISO
  price: number;
  isBundle?: boolean;
  isDamaged?: boolean;
  isIncomplete?: boolean;
  [key: string]: any;
}

export interface EstimateInput {
  player: string;
  product: string;
  cardNumber: string;
  parallel: string;
  auto?: boolean;
  grade?: string;
  comps: Comp[];
  activeListings?: Comp[];
  playerMomentum?: number;
  performance?: number;
}

export interface EstimateOutput {
  quickSale: number | null;
  fairMarketValue: number | null;
  premiumAsk: number | null;
  pricingMode: PricingMode;
  confidenceScore: number;
  liquidity: Liquidity;
  trend: Trend;
  compCountUsed: number;
  parallelInferenceActive: boolean;
  premiumExpansionApplied: boolean;
  debug: DebugOutput;
  explanation: string[];
}

export interface DebugOutput {
  weightedMedian: number | null;
  weighted25th: number | null;
  weighted75th: number | null;
  baseParallelRatio: number | null;
  adjustedParallelRatio: number | null;
  averageDateGapDays: number | null;
  bestDateGapDays: number | null;
  marketPressureScore: number | null;
}
