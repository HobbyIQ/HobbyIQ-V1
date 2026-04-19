import { Router } from 'express';
import { deepHealthController } from '../../controllers/deepHealthController';

const router = Router();

router.get('/deep-health', deepHealthController);

export default router;
