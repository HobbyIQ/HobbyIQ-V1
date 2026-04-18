import express from 'express';
import { cardOutcomeController } from '../controllers/outcomeController';

const router = express.Router();

router.post('/card-outlook', cardOutcomeController);

export default router;
