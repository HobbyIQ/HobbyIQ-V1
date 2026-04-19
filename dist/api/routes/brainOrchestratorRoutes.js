"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const brainOrchestratorController_1 = require("../../controllers/brainOrchestratorController");
const validationMiddleware_1 = require("../middleware/validationMiddleware");
const router = (0, express_1.Router)();
router.post('/full-analysis', validationMiddleware_1.validateFullAnalysis, brainOrchestratorController_1.fullAnalysisController);
exports.default = router;
