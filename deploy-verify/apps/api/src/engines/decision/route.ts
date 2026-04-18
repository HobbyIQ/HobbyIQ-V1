import { Router, Request, Response } from 'express';
import { runDecisionEngine } from './service';
import { DecisionEngineInput } from './types';

const router = Router();

// POST /api/decision/run
router.post('/run', (req: Request, res: Response) => {
  const input: DecisionEngineInput = req.body;
  try {
    const result = runDecisionEngine(input);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'Invalid input', details: err instanceof Error ? err.message : err });
  }
});

export default router;
