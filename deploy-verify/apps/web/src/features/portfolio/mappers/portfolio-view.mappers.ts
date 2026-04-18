import { PortfolioPositionDto, PortfolioPositionMetricsDto, PortfolioActionPlanDto, PortfolioPositionViewDto } from '../types/portfolio.types';

export function mapToPortfolioPositionView(
  position: PortfolioPositionDto,
  metrics: PortfolioPositionMetricsDto,
  actionPlan: PortfolioActionPlanDto,
  decisionSummary?: string,
  freshnessAsOf?: string
): PortfolioPositionViewDto {
  return {
    position,
    metrics,
    actionPlan,
    decisionSummary,
    freshnessAsOf,
  };
}
