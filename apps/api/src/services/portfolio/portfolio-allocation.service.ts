import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioAllocationSummary, PortfolioAllocationItem } from '../../domain/portfolio/portfolio-allocation';

export class PortfolioAllocationService {
  computeAllocation(userId: string, positions: PortfolioPosition[]): PortfolioAllocationSummary {
    const totalEstimatedValue = positions.reduce((sum, p) => sum + (p.currentTotalValue ?? 0), 0);
    const totalCostBasis = positions.reduce((sum, p) => sum + (p.totalCostBasis ?? 0), 0) || null;
    const totalUnrealizedGainLoss = positions.reduce((sum, p) => sum + ((p.currentTotalValue ?? 0) - (p.totalCostBasis ?? 0)), 0) || null;
    const totalUnrealizedGainLossPct = (totalUnrealizedGainLoss != null && totalCostBasis && totalCostBasis !== 0) ? (totalUnrealizedGainLoss / totalCostBasis) * 100 : null;
    const items: PortfolioAllocationItem[] = positions.map(p => ({
      entityType: p.entityType,
      entityKey: p.entityKey,
      displayLabel: p.displayLabel,
      currentTotalValue: p.currentTotalValue ?? 0,
      allocationPct: totalEstimatedValue ? ((p.currentTotalValue ?? 0) / totalEstimatedValue) * 100 : 0,
      convictionTag: p.convictionTag ?? null,
    }));
    return {
      userId,
      totalEstimatedValue,
      totalCostBasis,
      totalUnrealizedGainLoss,
      totalUnrealizedGainLossPct,
      items,
      updatedAt: new Date().toISOString(),
    };
  }
}
