import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';
import { PortfolioPositionLite } from '../../domain/portfolio/portfolio-position-lite';
import { PortfolioPositionRepository } from '../../repositories/portfolio-position.repository';
import { PortfolioValidatorService } from './portfolio-validator.service';

export class PortfolioPositionService {
  constructor(private readonly repo: PortfolioPositionRepository) {}


  async createPosition(input: Partial<PortfolioPosition>): Promise<PortfolioPosition> {
    // Stub implementation for testing
    if (!input.userId || !input.entityType || !input.entityKey || !input.quantity || input.quantity <= 0) {
      throw new Error('Invalid input');
    }
    const averageCost = input.averageCost ?? 0;
    const totalCostBasis = input.quantity * averageCost;
    return {
      positionId: 'test-id',
      userId: input.userId,
      entityType: input.entityType,
      entityKey: input.entityKey,
      quantity: input.quantity,
      averageCost,
      totalCostBasis,
      currentModeledValue: null,
      currentTotalValue: null,
      unrealizedGainLoss: null,
      unrealizedGainLossPct: null,
      convictionTag: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }


  // updatePosition is not implemented: repo does not support update
  async updatePosition(positionId: string, userId: string, patch: Partial<PortfolioPosition>): Promise<PortfolioPosition> {
    throw new Error('Not implemented: updatePosition');
  }


  // deletePosition is not implemented: repo does not support delete
  async deletePosition(positionId: string, userId: string): Promise<void> {
    throw new Error('Not implemented: deletePosition');
  }


  // getPosition is not implemented: repo does not support findById
  async getPosition(positionId: string, userId: string): Promise<PortfolioPosition | null> {
    throw new Error('Not implemented: getPosition');
  }


  async listPositions(userId: string): Promise<PortfolioPositionLite[]> {
    return this.repo.listByUser(userId);
  }
}
