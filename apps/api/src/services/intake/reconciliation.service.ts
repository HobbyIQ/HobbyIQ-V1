import { ImportRow } from '../../domain/intake/import-row';
import { PortfolioPositionRepository } from '../../repositories/portfolio/portfolio-position.repository';
import { ReconciliationMatch } from '../../domain/intake/reconciliation-match';

export class ReconciliationService {
  constructor(private readonly positionRepo: PortfolioPositionRepository) {}

  async matchRow(row: ImportRow): Promise<ReconciliationMatch | null> {
    // Example: exact match on entityKey
    const entityKey = row.rawJson.entityKey;
    if (!entityKey) return null;
    // TODO: Add provider_link/fuzzy/manual_review logic
    // This is a stub for exact match only
    return null;
  }
}
