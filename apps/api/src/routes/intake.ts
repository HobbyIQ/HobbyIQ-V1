import { Router } from 'express';
import { createIntakeController } from '../api/intake/intake.controller';
import { IntakeService } from '../api/intake/intake.service';
import { PortfolioImportService } from '../services/intake/portfolio-import.service';

// Compose dependencies
const portfolioImportService = new PortfolioImportService();
const intakeService = new IntakeService(portfolioImportService);

const router = createIntakeController(intakeService.importService);

export default router;
