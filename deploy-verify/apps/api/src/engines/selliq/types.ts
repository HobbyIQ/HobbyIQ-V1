// Types for the SellIQ Engine

export type SellSignal = 'sell_now' | 'wait' | 'reduce_price' | 'hold_for_auction';
export type AuctionVsBIN = 'auction' | 'bin' | 'either';
export type CardTier = 'low' | 'mid' | 'high' | 'grail';

export interface SellIQAnalysisResult {
  currentFMV: number;
  riskAdjustedFMV: number;
  quickExitFMV: number;
  compTrendPercent: number; // -100 to 100
  liquidityScore: number; // 0-100
  activeListingCount: number;
  soldCountRecent: number;
  cardTier: CardTier;
  marketMomentumScore: number; // -100 to 100
  urgencyScore: number; // 0-100
  costBasis?: number;
  decisionRecommendation?: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
  negativePressureScore?: number;
}

export interface SellIQOutput {
  sellSignal: SellSignal;
  sellConfidence: number; // 0-100
  listPriceRecommendation: number;
  minimumAcceptableOffer: number;
  quickSalePrice: number;
  auctionVsBINRecommendation: AuctionVsBIN;
  repricingPlan: string;
  timeToExitRecommendation: string;
  expectedStrategy: string;
  reasoning: string[];
}
