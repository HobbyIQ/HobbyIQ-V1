export interface PortfolioExposure {
  userId: string;
  entityKey: string;
  exposureScore: number;
  overexposed: boolean;
  notes: string[];
}
