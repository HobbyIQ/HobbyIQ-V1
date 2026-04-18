import { PortfolioPositionService } from '../services/portfolio/portfolio-position.service';
import { PortfolioAlertContextService } from '../services/portfolio/portfolio-alert-context.service';

export class PortfolioAlertSyncJob {
  constructor(
    private readonly positionService: PortfolioPositionService,
    private readonly alertContextService: PortfolioAlertContextService,
  ) {}

  async run(userId: string) {
    const positions = await this.positionService.listPositions(userId);
    for (const p of positions) {
      const position = {
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
      };
      const alerts = this.alertContextService.getAlertContext(position);
      // TODO: Feed alerts into alert system
    }
  }
}
