// Service composition for intake API
import { PortfolioImportService } from '../../services/intake/portfolio-import.service';

export class IntakeService {
  constructor(public readonly importService: PortfolioImportService) {}
}
