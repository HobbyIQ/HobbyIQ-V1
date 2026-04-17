import { PortfolioPositionLite } from "../domain/portfolio/portfolio-position-lite";

export interface PortfolioPositionRepository {
  listByUser(userId: string): Promise<PortfolioPositionLite[]>;
  findByEntity(userId: string, entityType: string, entityKey: string): Promise<PortfolioPositionLite | null>;
}
