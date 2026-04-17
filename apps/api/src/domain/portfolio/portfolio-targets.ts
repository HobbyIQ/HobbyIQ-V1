export interface PortfolioTargets {
  positionId: string;
  addTargetPrice?: number | null;
  trimTargetPrice?: number | null;
  sellTargetPrice?: number | null;
  protectCapitalPrice?: number | null;
  maxAllocationPct?: number | null;
  notes?: string | null;
  updatedAt: string;
}
