import express from 'express';
import { cardDecisionController, healthController, bestBuysController, marketMoversController, playerSummaryController } from '../controllers/brainController';
import { fullAnalysisController } from '../controllers/fullAnalysisController';

const router = express.Router();

// MCP HobbyIQ Brain health route (MCP standard)
router.get('/health', (req, res) => res.json({ status: 'MCP HobbyIQ Brain running' }));
// Legacy/other health controller (if needed, add as /health-legacy or similar)
// router.get('/health-legacy', healthController);
router.post('/card-decision', cardDecisionController);
router.get('/best-buys', bestBuysController);
router.get('/market-movers', marketMoversController);
router.get('/player-summary/:player', playerSummaryController);


// Unified full analysis endpoint
router.post('/full-analysis', fullAnalysisController);

export default router;
