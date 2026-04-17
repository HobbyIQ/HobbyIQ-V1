// Shared domain models for Market Intelligence

export interface MarketPriceBands {
  quickExitPrice: number;
  fairMarketValue: number;
  buyZoneLow: number;
  buyZoneHigh: number;
  holdZoneLow: number;
  holdZoneHigh: number;
  sellZoneLow: number;
  sellZoneHigh: number;
  stretchAsk: number;
}

export interface RecentComp {
  date: string;
  title: string;
  price: number;
  grade: string | null;
  source: string;
  listingType: "auction" | "bin" | "best_offer" | "unknown";
  acceptedOfferKnown: boolean;
  weight: number;
  normalized: boolean;
  notes?: string;
}

export interface SupplyDemandWindow {
  window: "2w" | "4w" | "3m";
  activeListingsAvg: number;
  soldCount: number;
  soldToListingRatio: number;
  absorptionRate: number;
  newListingVelocity: number;
  priceTrendPct: number;
  supplyTrendPct: number;
  demandTrendPct: number;
  signal: string;
}

export interface MarketLadderRung {
  label: string;
  cardKey: string;
  estimatedPrice: number;
  compCount: number;
  liquidityScore: number;
  activeSupply: number;
  supplyTrend: "up" | "flat" | "down";
  demandTrend: "up" | "flat" | "down";
}

export interface BuyOpportunity {
  title: string;
  marketplace: string;
  listingPrice: number;
  estimatedFmv: number;
  buyZoneLow: number;
  buyZoneHigh: number;
  estimatedUpsidePct: number;
  buyScore: number;
  reason: string;
  riskNotes: string[];
  listingUrl?: string;
}

export interface MarketSignals {
  liquidityScore: number;
  confidenceScore: number;
  marketTrend: "rising" | "flat" | "cooling";
  supplyTrend2Weeks: "up" | "flat" | "down";
  supplyTrend4Weeks: "up" | "flat" | "down";
  supplyTrend3Months: "up" | "flat" | "down";
  demandTrend2Weeks: "up" | "flat" | "down";
  demandTrend4Weeks: "up" | "flat" | "down";
  demandTrend3Months: "up" | "flat" | "down";
  explanation: string[];
}

export interface CompCalculationContext {
  weightedMedian: number;
  weightedAverage: number;
  compCount: number;
  minComp?: number;
  maxComp?: number;
  liquidityScore: number;
  confidenceScore: number;
  marketTrend: "rising" | "flat" | "cooling";
  supplyDemandRaw?: any;
  listings?: Array<{ title: string; price: number; url?: string }>;
  priceBands: MarketPriceBands;
  cardKey: string;
}
