import { brainOrchestrator } from '../../brain/orchestration/brainOrchestrator';
import { Request, Response, NextFunction } from 'express';

export async function fullAnalysisController(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await brainOrchestrator(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}
