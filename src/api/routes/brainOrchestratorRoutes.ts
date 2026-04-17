import { Router } from 'express';
import { fullAnalysisController } from '../controllers/brainOrchestratorController';
import { validateFullAnalysis } from '../middleware/validationMiddleware';

const router = Router();

router.post('/full-analysis', validateFullAnalysis, fullAnalysisController);

export default router;
