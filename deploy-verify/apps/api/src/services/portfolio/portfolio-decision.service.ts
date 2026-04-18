import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioPositionMetrics } from '../../domain/portfolio/portfolio-metrics';

export type PortfolioDecisionAction = "buy_more" | "hold" | "trim" | "sell" | "watch" | "avoid_adding";

export class PortfolioDecisionService {
  // In real impl, use Decision Layer, risk, targets, etc.
  recommendAction(metrics: PortfolioPositionMetrics): PortfolioDecisionAction {
    if (metrics.unrealizedGainLossPct != null) {
      if (metrics.unrealizedGainLossPct > 40) return "trim";
      if (metrics.unrealizedGainLossPct < -15) return "watch";
      if (metrics.unrealizedGainLossPct > 10) return "hold";
      if (metrics.unrealizedGainLossPct < 0) return "buy_more";
    }
    return "hold";
  }
}
