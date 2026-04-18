import { Router } from 'express';
import { createIntakeController } from '../api/intake/intake.controller';
import { IntakeService } from '../api/intake/intake.service';
import { PortfolioImportService } from '../services/intake/portfolio-import.service';

// Compose dependencies
// TODO: Replace these stubs with actual repository implementations
const batchRepoStub = {} as any;
const rowRepoStub = {} as any;
const reconciliationRepoStub = {} as any;
const positionRepoStub = {} as any;
const portfolioImportService = new PortfolioImportService(batchRepoStub, rowRepoStub, reconciliationRepoStub, positionRepoStub);
const intakeService = new IntakeService(portfolioImportService);

const router = createIntakeController(intakeService.importService);

export default router;
