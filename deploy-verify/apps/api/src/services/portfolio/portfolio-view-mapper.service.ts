import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioPositionMetrics } from '../../domain/portfolio/portfolio-metrics';
import { PortfolioActionPlan } from '../../domain/portfolio/portfolio-action-plan';

export class PortfolioViewMapperService {
  static toViewDto(position: PortfolioPosition, metrics: PortfolioPositionMetrics, actionPlan: PortfolioActionPlan, decisionSummary?: string, freshnessAsOf?: string) {
    return {
      position,
      metrics,
      actionPlan,
      decisionSummary,
      freshnessAsOf,
    };
  }
}
