import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

export const fullAnalysisSchema = z.object({
  player: z.string(),
  cardSet: z.string(),
  year: z.number(),
  product: z.string(),
  parallel: z.string().optional(),
  grade: z.string().optional(),
  currentEstimatedValue: z.number().optional(),
  askingPrice: z.number().optional(),
  userIntent: z.string().optional(),
  events: z.array(z.string()).optional()
});

export function validateFullAnalysis(req: Request, res: Response, next: NextFunction) {
  try {
    fullAnalysisSchema.parse(req.body);
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.errors || 'Validation error' });
  }
}
