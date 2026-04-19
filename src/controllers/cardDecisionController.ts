import { Request, Response } from 'express';

export async function cardDecisionController(req: Request, res: Response) {
  try {
    // Stub handler
    const result = { success: true, message: 'Stub card decision' };
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
