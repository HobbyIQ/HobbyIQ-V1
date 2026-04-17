import { PortfolioPositionRepository } from '../../repositories/portfolio-position.repository';
import { PortfolioPositionService } from '../../services/portfolio/portfolio-position.service';
import { PortfolioMetricsService } from '../../services/portfolio/portfolio-metrics.service';
import { PortfolioAllocationService } from '../../services/portfolio/portfolio-allocation.service';
import { PortfolioExposureService } from '../../services/portfolio/portfolio-exposure.service';
import { PortfolioSummaryService } from '../../services/portfolio/portfolio-summary.service';
import { PortfolioDecisionService } from '../../services/portfolio/portfolio-decision.service';
import { PortfolioActionPlanService } from '../../services/portfolio/portfolio-action-plan.service';
import { PortfolioImportService } from '../../services/portfolio/portfolio-import.service';

// Compose all portfolio services here for controller use
export class PortfolioService {
  constructor(
    public readonly position: PortfolioPositionService,
    public readonly metrics: PortfolioMetricsService,
    public readonly allocation: PortfolioAllocationService,
    public readonly exposure: PortfolioExposureService,
    public readonly summary: PortfolioSummaryService,
    public readonly decision: PortfolioDecisionService,
    public readonly actionPlan: PortfolioActionPlanService,
    public readonly importService: PortfolioImportService,
  ) {}
}
