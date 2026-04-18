import { Router } from 'express';
import { compiqQuery, compiqEstimate, compiqHealth } from '../controllers/compiq.controller';

const router = Router();

router.post('/query', compiqQuery);
router.post('/estimate', compiqEstimate);
router.get('/health', compiqHealth);

export default router;
