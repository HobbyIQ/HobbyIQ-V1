export interface CompIQInput {
  player: string;
  cardSet?: string;
  productFamily?: string;
  year?: number;
  parallel?: string;
  isAuto?: boolean;
  grade?: string;
  serial?: string;
  rawPrice?: number;
  recentComps?: CompSale[];
  activeSupply?: SupplySnapshot;
  demandMetrics?: any;
  marketContext?: any;
}

export interface CompSale {
  date: string;
  price: number;
  grade?: string;
  source?: string;
  notes?: string;
}

export interface SupplySnapshot {
  totalListed: number;
  trend2w: number;
  trend4w: number;
  trend3m: number;
}

export interface CompIQOutput extends CompIQInput {
  success: boolean;
  title: string;
  summary: string;
  normalizedParallel?: string;
  estimatedRaw?: number;
  estimatedPsa10?: number;
  estimatedPsa9?: number;
  estimatedPsa8?: number;
  fairMarketValue?: number;
  compRangeLow?: number;
  compRangeHigh?: number;
  buyTarget?: number;
  confidenceScore?: number;
  compCount?: number;
  recentComps?: CompSale[];
  marketLadder?: MarketLadderTier[];
  supplyAnalysis?: SupplyAnalysis;
  pricingSignals?: string[];
  plainEnglishBullets?: string[];
  nextActions?: string[];
}

export interface MarketLadderTier {
  tier: string;
  price: number;
  notes?: string;
}

export interface SupplyAnalysis {
  totalListed: number;
  trend2w: number;
  trend4w: number;
  trend3m: number;
  interpretation: string;
}
