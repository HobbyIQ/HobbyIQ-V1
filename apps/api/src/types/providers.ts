// Learning system provider/segment types
export type MarketSegmentKey =
  | "raw_base"
  | "psa9_base"
  | "psa10_base"
  | "auto_non_numbered"
  | "auto_mid_numbered"
  | "auto_low_numbered"
  | "ultra_low_serial"
  | "sapphire"
  | "bowman_1st_auto"
  | "topps_chrome_rookie"
  | "prospect_hype"
  | "mlb_established";

export type ProviderMode = "mock" | "azure";

export type FeatureKey =
  | "basicAlerts"
  | "advancedAlerts"
  | "premiumSignals"
  | "learning"
  | "promptExperiments"
  | "autoWeightUpdates";

export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";
// Provider interfaces for HobbyIQ backend

export interface CompResult {
  cardId: string;
  price: number;
  date: string;
  source: string;
}

export interface CompsProvider {
  getComps(query: string): Promise<CompResult[]>;
  health(): Promise<{ status: string; details?: any }>;
}

export interface SupplyResult {
  cardId: string;
  supply: number;
  notes?: string;
}

export interface SupplyProvider {
  getSupply(cardId: string): Promise<SupplyResult>;
  health(): Promise<{ status: string; details?: any }>;
}

export interface PlayerPerformanceResult {
  playerId: string;
  stats: Record<string, any>;
  notes?: string;
}

export interface PlayerPerformanceProvider {
  getPerformance(playerId: string): Promise<PlayerPerformanceResult>;
  health(): Promise<{ status: string; details?: any }>;
}
