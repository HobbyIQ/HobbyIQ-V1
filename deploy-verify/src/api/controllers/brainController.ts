import { Request, Response } from 'express';
import { validateCardDecision } from '../../brain/schemas/cardDecisionSchema';
import { cardDecisionHandler } from '../../brain/handlers/cardDecisionHandler';
import { getBestBuys, getMarketMovers, getPlayerSummary } from '../../brain/handlers/marketHandlers';

export const cardDecisionController = async (req: Request, res: Response) => {
  const { error, value } = validateCardDecision(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details.map(d => d.message) });
  }
  try {
    const result = await cardDecisionHandler(value);
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
    const result = await getBestBuys();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const marketMoversController = async (_req: Request, res: Response) => {
  try {
    const result = await getMarketMovers();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const playerSummaryController = async (req: Request, res: Response) => {
  try {
    const result = await getPlayerSummary(req.params.player);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
