// Market stats for CompIQ
export interface CompIQMarketStats {
  fmv: number | null;
  low: number | null;
  high: number | null;
  trend: number | null;
  liquidity: number | null;
  compCount: number;
  confidence: number;
  compsUsed: CompIQSoldListing[];
}
// Types for CompIQ Apify integration
// Types for CompIQ Apify integration
export interface CompIQSoldListing {
  title: string;
  soldPrice: number;
  soldDate: string; // ISO
  rawTitle: string;
  source: string;
  url?: string;
}

export interface CompIQFetchParams {
  player: string;
  set?: string;
  parallel?: string;
  isAuto?: boolean;
  serial?: string;
  maxResults?: number;
}
