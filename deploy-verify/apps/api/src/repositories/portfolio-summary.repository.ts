import { PortfolioSummary } from '../domain/portfolio/portfolio-summary';

export interface PortfolioSummaryRepository {
  save(summary: PortfolioSummary): Promise<void>;
  getByUser(userId: string): Promise<PortfolioSummary | null>;
}
