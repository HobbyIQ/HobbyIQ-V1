import { PortfolioExposureSummary, PortfolioExposureItem } from '../../domain/portfolio/portfolio-exposure';
import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { portfolioConfig } from '../../config/portfolio.config';

export class PortfolioExposureService {
  computeExposure(userId: string, positions: PortfolioPosition[]): PortfolioExposureSummary {
    const items: PortfolioExposureItem[] = positions.map(p => {
      const allocationPct = p.currentTotalValue && positions.length > 0
        ? ((p.currentTotalValue ?? 0) / positions.reduce((sum, pos) => sum + (pos.currentTotalValue ?? 0), 0)) * 100
        : 0;
      const overexposed = allocationPct > portfolioConfig.overexposureAllocationThresholdPct;
      const notes: string[] = [];
      if (overexposed) notes.push(`This position is ${allocationPct.toFixed(1)}% of your portfolio.`);
      if (p.convictionTag === 'spec') notes.push('Speculative position.');
      return {
        entityKey: p.entityKey,
        exposureScore: allocationPct,
        overexposed,
        notes,
      };
    });
    return {
      userId,
      items,
      updatedAt: new Date().toISOString(),
    };
  }
}
