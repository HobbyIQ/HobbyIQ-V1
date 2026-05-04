import { PortfolioTargets } from '../../domain/portfolio/portfolio-targets';

export interface PortfolioTargetsRepository {
  create(targets: PortfolioTargets): Promise<PortfolioTargets>;
  update(targets: PortfolioTargets): Promise<PortfolioTargets>;
  delete(positionId: string): Promise<void>;
  findByPosition(positionId: string): Promise<PortfolioTargets | null>;
}
