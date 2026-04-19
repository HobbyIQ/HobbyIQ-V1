import { Router } from 'express';
import { cardDecisionController } from '../../controllers/cardDecisionController';

const router = Router();

router.post('/card-decision', cardDecisionController);

export default router;
