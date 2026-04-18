const express = require('express');
const { analyzePlayeriq } = require('../services/playeriqService');
const router = express.Router();

// POST /api/playeriq/pricing-summary
router.post('/pricing-summary', async (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    if (!playerName || typeof playerName !== 'string' || !playerName.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "playerName" field',
        meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() }
      });
    }
    const result = await analyzePlayeriq({ player: playerName });
    res.json({ ...result, meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// POST /api/playeriq/search
router.post('/search', async (req, res, next) => {
  try {
    const { playerName } = req.body || {};
    if (!playerName || typeof playerName !== 'string' || !playerName.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "playerName" field',
        meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() }
      });
    }
    // For now, just return the same as /pricing-summary (mock)
    const result = await analyzePlayeriq({ player: playerName });
    res.json({ ...result, meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// Legacy endpoint for compatibility
router.post('/analyze', async (req, res, next) => {
  try {
    const result = await analyzePlayeriq(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
