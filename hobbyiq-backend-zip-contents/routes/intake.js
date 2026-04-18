"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const intake_controller_1 = require("../api/intake/intake.controller");
const intake_service_1 = require("../api/intake/intake.service");
const portfolio_import_service_1 = require("../services/intake/portfolio-import.service");
// Compose dependencies
// TODO: Replace these stubs with actual repository implementations
const batchRepoStub = {};
const rowRepoStub = {};
const reconciliationRepoStub = {};
const positionRepoStub = {};
const portfolioImportService = new portfolio_import_service_1.PortfolioImportService(batchRepoStub, rowRepoStub, reconciliationRepoStub, positionRepoStub);
const intakeService = new intake_service_1.IntakeService(portfolioImportService);
const router = (0, intake_controller_1.createIntakeController)(intakeService.importService);
exports.default = router;
