import { PortfolioPositionService } from '../services/portfolio/portfolio-position.service';
import { PortfolioAlertContextService } from '../services/portfolio/portfolio-alert-context.service';

export class PortfolioAlertSyncJob {
  constructor(
    private readonly positionService: PortfolioPositionService,
    private readonly alertContextService: PortfolioAlertContextService,
  ) {}

  async run(userId: string) {
    const positions = await this.positionService.listPositions(userId);
    for (const position of positions) {
      const alerts = this.alertContextService.getAlertContext(position);
      // TODO: Feed alerts into alert system
    }
  }
}
