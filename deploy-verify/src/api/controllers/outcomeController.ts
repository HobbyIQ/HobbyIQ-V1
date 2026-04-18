import { Request, Response } from 'express';
import { validateCardOutcome } from '../../brain/schemas/cardOutcomeSchema';
import { cardOutcomeHandler } from '../../brain/handlers/cardOutcomeHandler';

export const cardOutcomeController = async (req: Request, res: Response) => {
  const { error, value } = validateCardOutcome(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details.map(d => d.message) });
  }
  try {
    const result = await cardOutcomeHandler(value);
    res.json(result);
  } catch (err) {
    console.error('Card outcome error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
