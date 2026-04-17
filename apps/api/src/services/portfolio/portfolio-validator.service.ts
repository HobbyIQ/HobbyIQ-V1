import { PortfolioPosition } from '../../domain/portfolio/portfolio-position';

export class PortfolioValidatorService {
  static validatePosition(input: Partial<PortfolioPosition>): string[] {
    const errors: string[] = [];
    if (!input.userId) errors.push('userId is required');
    if (!input.entityType || (input.entityType !== 'card' && input.entityType !== 'player')) errors.push('entityType must be card or player');
    if (!input.entityKey) errors.push('entityKey is required');
    if (typeof input.quantity !== 'number' || input.quantity <= 0) errors.push('quantity must be > 0');
    if (input.averageCost != null && input.averageCost < 0) errors.push('averageCost cannot be negative');
    // Consistency checks
    if (input.entityType === 'card' && input.cardKey && input.entityKey !== input.cardKey) errors.push('entityKey/cardKey mismatch');
    if (input.entityType === 'player' && input.playerId && input.entityKey !== input.playerId) errors.push('entityKey/playerId mismatch');
    return errors;
  }
}
