import { PortfolioExposure } from '../../domain/portfolio/portfolio-exposure';
import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { portfolioConfig } from '../../config/portfolio.config';

export class PortfolioExposureService {
  computeExposure(userId: string, positions: PortfolioPosition[]): PortfolioExposure[] {
    const totalValue = positions.reduce((sum, pos) => sum + (pos.currentTotalValue ?? 0), 0);
    return positions.map(p => {
      const allocationPct = totalValue > 0 ? ((p.currentTotalValue ?? 0) / totalValue) * 100 : 0;
      const overexposed = allocationPct > portfolioConfig.overexposureAllocationThresholdPct;
      const notes: string[] = [];
      if (overexposed) notes.push(`This position is ${allocationPct.toFixed(1)}% of your portfolio.`);
      if (p.convictionTag === 'spec') notes.push('Speculative position.');
      return {
        userId,
        entityKey: p.entityKey,
        exposureScore: allocationPct,
        overexposed,
        notes,
      };
    });
  }
}
