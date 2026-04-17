import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';

export class PortfolioValuationService {
  // This should use snapshot/decision services in real impl
  async getCurrentModeledValue(position: PortfolioPosition): Promise<number | null> {
    // TODO: Integrate with snapshot/decision layer
    return position.currentModeledValue ?? null;
  }

  async getCurrentTotalValue(position: PortfolioPosition): Promise<number | null> {
    const modeled = await this.getCurrentModeledValue(position);
    return modeled != null && position.quantity ? modeled * position.quantity : null;
  }
}
