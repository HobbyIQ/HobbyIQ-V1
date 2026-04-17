import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';

export class PortfolioAlertContextService {
  getAlertContext(position: PortfolioPosition): string[] {
    const alerts: string[] = [];
    if (position.unrealizedGainLossPct != null && position.unrealizedGainLossPct > 40) {
      alerts.push('Trim alert: Strong gains.');
    }
    if (position.unrealizedGainLossPct != null && position.unrealizedGainLossPct < -15) {
      alerts.push('Protect capital alert: Drawdown.');
    }
    // Add more alert context logic as needed
    return alerts;
  }
}
