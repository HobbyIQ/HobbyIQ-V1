import { PortfolioPositionService } from '../services/portfolio/portfolio-position.service';
import { PortfolioSummaryService } from '../services/portfolio/portfolio-summary.service';
import { PortfolioAllocationService } from '../services/portfolio/portfolio-allocation.service';
import { PortfolioExposureService } from '../services/portfolio/portfolio-exposure.service';

export class PortfolioRollupJob {
  constructor(
    private readonly positionService: PortfolioPositionService,
    private readonly summaryService: PortfolioSummaryService,
    private readonly allocationService: PortfolioAllocationService,
    private readonly exposureService: PortfolioExposureService,
  ) {}

  async run(userId: string) {
    const positions = await this.positionService.listPositions(userId);
    const fullPositions = positions.map(p => ({
      ...p,
      quantity: p.quantity ?? 0,
      averageCost: p.averageCost ?? null,
      totalCostBasis: null,
      currentModeledValue: null,
      currentTotalValue: null,
      unrealizedGainLoss: null,
      unrealizedGainLossPct: null,
      convictionTag: (p.convictionTag as any) ?? null,
      notes: null,
    }));
    const summary = this.summaryService.computeSummary(userId, fullPositions);
    const allocation = this.allocationService.computeAllocation(userId, fullPositions);
    const exposure = this.exposureService.computeExposure(userId, fullPositions);
    // TODO: Persist summary/allocation/exposure if needed
    return { summary, allocation, exposure };
  }
}
