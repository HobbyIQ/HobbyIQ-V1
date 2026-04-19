import { Request, Response } from 'express';
import { z } from 'zod';
import { runCompiqEstimate } from '../services/compiqEstimateService';

export const compiqHealth = (req: Request, res: Response) => {
  res.json({ status: 'ok', engine: 'Dynamic Parallel Engine' });
};

const EstimateRequestSchema = z.object({
  player: z.string(),
  product: z.string(),
  cardNumber: z.string(),
  parallel: z.string(),
  auto: z.boolean().optional(),
  grade: z.string().optional(),
  comps: z.array(z.any()), // To be refined
  activeListings: z.array(z.any()).optional(),
  playerMomentum: z.number().optional(),
  performance: z.number().optional(),
});

export const compiqEstimate = async (req: Request, res: Response) => {
  try {
    const input = EstimateRequestSchema.parse(req.body);
    const result = await runCompiqEstimate(input);
    res.json(result);
  } catch (err: any) {
    console.error('[compiqEstimate]', err);
    res.status(400).json({ error: err.message || 'Invalid request' });
  }
};
