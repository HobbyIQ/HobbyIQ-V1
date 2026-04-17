import { PortfolioMetricsService } from '../../src/services/portfolio/portfolio-metrics.service';
import { PortfolioValuationService } from '../../src/services/portfolio/portfolio-valuation.service';
import { PortfolioPosition } from '../../src/domain/portfolio/portfolio-position';

describe('PortfolioMetricsService', () => {
  const valuation = new PortfolioValuationService();
  const service = new PortfolioMetricsService(valuation);

  it('should compute metrics with gain', async () => {
    const position: PortfolioPosition = {
      positionId: 'p1',
      userId: 'u1',
      entityType: 'card',
      entityKey: 'c1',
      quantity: 2,
      averageCost: 100,
      totalCostBasis: 200,
      currentModeledValue: 150,
      currentTotalValue: 300,
      unrealizedGainLoss: null,
      unrealizedGainLossPct: null,
      createdAt: '',
      updatedAt: '',
    };
    const metrics = await service.computeMetrics(position, 50);
    expect(metrics.unrealizedGainLoss).toBe(100);
    expect(metrics.unrealizedGainLossPct).toBe(50);
    expect(metrics.allocationPct).toBe(50);
  });
});
