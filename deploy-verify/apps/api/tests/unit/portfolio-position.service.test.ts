import { PortfolioPositionService } from '../../src/services/portfolio/portfolio-position.service';
import { PortfolioPositionRepository } from '../../src/repositories/portfolio-position.repository';
import { PortfolioPosition } from '../../src/domain/portfolio/portfolio-position';

describe('PortfolioPositionService', () => {
  const repo: PortfolioPositionRepository = {
    listByUser: jest.fn(async () => []),
    findByEntity: jest.fn(async () => null),
  };
  const service = new PortfolioPositionService(repo);

  it('should validate and create a position', async () => {
    const input: Partial<PortfolioPosition> = {
      userId: 'u1',
      entityType: 'card',
      entityKey: 'c1',
      quantity: 2,
      averageCost: 100,
    };
    const result = await service.createPosition(input);
    expect(result.userId).toBe('u1');
    expect(result.quantity).toBe(2);
    expect(result.totalCostBasis).toBe(200);
  });

  it('should throw on invalid quantity', async () => {
    await expect(service.createPosition({ userId: 'u1', entityType: 'card', entityKey: 'c1', quantity: 0 })).rejects.toThrow();
  });
});
