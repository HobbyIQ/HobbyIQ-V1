import { Request, Response } from 'express';

export const cardDecisionController = async (req: Request, res: Response) => {
  try {
    // Stub handler
    const result = { success: true, message: 'Stub card decision' };
    res.json(result);
  } catch (err) {
    console.error('Card decision error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const healthController = (_req: Request, res: Response) => {
  res.json({ status: 'MCP HobbyIQ Brain running' });
};

export const bestBuysController = async (_req: Request, res: Response) => {
  try {
    const result = { success: true, message: 'Stub best buys' };
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const marketMoversController = async (_req: Request, res: Response) => {
  try {
    const result = { success: true, message: 'Stub market movers' };
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const playerSummaryController = async (_req: Request, res: Response) => {
  try {
    const result = { success: true, message: 'Stub player summary' };
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
