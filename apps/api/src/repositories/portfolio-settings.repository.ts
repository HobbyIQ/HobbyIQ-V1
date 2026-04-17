import { PortfolioSettings } from '../domain/portfolio/portfolio-settings';

export interface PortfolioSettingsRepository {
  getByUser(userId: string): Promise<PortfolioSettings | null>;
  upsert(settings: PortfolioSettings): Promise<PortfolioSettings>;
}
