import express from 'express';
import { fullAnalysisController } from '../../controllers/fullAnalysisController';

const router = express.Router();

router.post('/full-analysis', fullAnalysisController);

export default router;
