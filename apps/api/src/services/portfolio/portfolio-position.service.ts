import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioPositionRepository } from '../../repositories/portfolio-position.repository';
import { PortfolioValidatorService } from './portfolio-validator.service';

export class PortfolioPositionService {
  constructor(private readonly repo: PortfolioPositionRepository) {}

  async createPosition(input: Partial<PortfolioPosition>): Promise<PortfolioPosition> {
    const errors = PortfolioValidatorService.validatePosition(input);
    if (errors.length) throw new Error(errors.join(', '));
    const now = new Date().toISOString();
    const position: PortfolioPosition = {
      ...input,
      positionId: input.positionId || crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      totalCostBasis: input.totalCostBasis ?? (input.quantity && input.averageCost != null ? input.quantity * input.averageCost : null),
    } as PortfolioPosition;
    // TODO: Enrich with display label if possible
    return this.repo.create(position);
  }

  async updatePosition(positionId: string, userId: string, patch: Partial<PortfolioPosition>): Promise<PortfolioPosition> {
    const existing = await this.repo.findById(positionId, userId);
    if (!existing) throw new Error('Position not found');
    const updated: PortfolioPosition = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
      totalCostBasis: patch.totalCostBasis ?? (patch.quantity && patch.averageCost != null ? patch.quantity * patch.averageCost : existing.totalCostBasis),
    };
    const errors = PortfolioValidatorService.validatePosition(updated);
    if (errors.length) throw new Error(errors.join(', '));
    return this.repo.update(updated);
  }

  async deletePosition(positionId: string, userId: string): Promise<void> {
    return this.repo.delete(positionId, userId);
  }

  async getPosition(positionId: string, userId: string): Promise<PortfolioPosition | null> {
    return this.repo.findById(positionId, userId);
  }

  async listPositions(userId: string): Promise<PortfolioPosition[]> {
    return this.repo.listByUser(userId);
  }
}
