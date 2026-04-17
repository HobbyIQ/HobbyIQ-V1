import { PortfolioLot } from '../domain/portfolio/portfolio-lot';

export interface PortfolioLotRepository {
  create(lot: PortfolioLot): Promise<PortfolioLot>;
  update(lot: PortfolioLot): Promise<PortfolioLot>;
  delete(lotId: string, userId: string): Promise<void>;
  listByPosition(positionId: string, userId: string): Promise<PortfolioLot[]>;
}
