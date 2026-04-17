import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioPositionMetrics } from '../../domain/portfolio/portfolio-metrics';
import { PortfolioValuationService } from './portfolio-valuation.service';

export class PortfolioMetricsService {
  constructor(private readonly valuation: PortfolioValuationService) {}

  async computeMetrics(position: PortfolioPosition, allocationPct: number | null = null): Promise<PortfolioPositionMetrics> {
    const currentModeledValue = await this.valuation.getCurrentModeledValue(position);
    const currentTotalValue = await this.valuation.getCurrentTotalValue(position);
    const totalCostBasis = position.totalCostBasis;
    const unrealizedGainLoss = (currentTotalValue != null && totalCostBasis != null) ? currentTotalValue - totalCostBasis : null;
    const unrealizedGainLossPct = (unrealizedGainLoss != null && totalCostBasis && totalCostBasis !== 0) ? (unrealizedGainLoss / totalCostBasis) * 100 : null;
    return {
      positionId: position.positionId,
      quantity: position.quantity,
      averageCost: position.averageCost,
      totalCostBasis,
      currentModeledValue,
      currentTotalValue,
      unrealizedGainLoss,
      unrealizedGainLossPct,
      allocationPct,
      riskScore: null,
      decisionAction: null,
      actionConfidence: null,
      freshnessAsOf: null,
    };
  }
}
