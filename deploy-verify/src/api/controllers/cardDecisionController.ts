import { cardDecisionHandler } from '../../brain/handlers/cardDecisionHandler';
import { Request, Response } from 'express';

export async function cardDecisionController(req: Request, res: Response) {
  try {
    const result = await cardDecisionHandler(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
