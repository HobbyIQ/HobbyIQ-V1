// Types for future modules (scarcity, supply, gem rate, decision, portfolio)
export interface ScarcityInfo {
  // TODO: Define fields
}
export interface SupplyInfo {
  // TODO: Define fields
}
export interface GemRateInfo {
  // TODO: Define fields
}
export interface DecisionInfo {
  // TODO: Define fields
}
export type PortfolioEntry = {
  id: string;
  player: string;
  card: string;
  year: number;
  team: string;
  grade: string | null;
  value: number;
};
