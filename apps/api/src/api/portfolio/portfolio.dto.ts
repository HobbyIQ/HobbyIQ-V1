import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioTargets } from '../../domain/portfolio/portfolio-targets';
import { PortfolioPositionMetrics } from '../../domain/portfolio/portfolio-metrics';
import { PortfolioActionPlan } from '../../domain/portfolio/portfolio-action-plan';
import { PortfolioSummary } from '../../domain/portfolio/portfolio-summary';
import { PortfolioAllocationSummary } from '../../domain/portfolio/portfolio-allocation';
import { PortfolioExposureSummary } from '../../domain/portfolio/portfolio-exposure';

export interface PortfolioPositionDto extends PortfolioPosition {}
export interface PortfolioTargetsDto extends PortfolioTargets {}
export interface PortfolioPositionMetricsDto extends PortfolioPositionMetrics {}
export interface PortfolioActionPlanDto extends PortfolioActionPlan {}
export interface PortfolioSummaryDto extends PortfolioSummary {}
export interface PortfolioAllocationSummaryDto extends PortfolioAllocationSummary {}
export interface PortfolioExposureSummaryDto extends PortfolioExposureSummary {}

export interface PortfolioPositionViewDto {
  position: PortfolioPositionDto;
  metrics: PortfolioPositionMetricsDto;
  actionPlan: PortfolioActionPlanDto;
  decisionSummary?: string;
  freshnessAsOf?: string;
}
