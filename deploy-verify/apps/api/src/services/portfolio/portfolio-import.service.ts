import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioPositionService } from './portfolio-position.service';

export interface PortfolioImportResult {
  created: number;
  failed: number;
  errors: { row: number; error: string }[];
}

export class PortfolioImportService {
  constructor(private readonly positionService: PortfolioPositionService) {}

  async importPositions(userId: string, positions: Partial<PortfolioPosition>[]): Promise<PortfolioImportResult> {
    let created = 0, failed = 0;
    const errors: { row: number; error: string }[] = [];
    for (let i = 0; i < positions.length; i++) {
      try {
        await this.positionService.createPosition({ ...positions[i], userId });
        created++;
      } catch (e: any) {
        failed++;
        errors.push({ row: i, error: e.message });
      }
    }
    return { created, failed, errors };
  }
}
