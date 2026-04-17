import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';

export interface PortfolioPositionRepository {
  create(position: PortfolioPosition): Promise<PortfolioPosition>;
  update(position: PortfolioPosition): Promise<PortfolioPosition>;
  delete(positionId: string, userId: string): Promise<void>;
  listByUser(userId: string): Promise<PortfolioPosition[]>;
  findByEntity(userId: string, entityType: 'card' | 'player', entityKey: string): Promise<PortfolioPosition | null>;
}
