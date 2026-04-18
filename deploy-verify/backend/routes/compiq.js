const express = require('express');
const { analyzeCompiq } = require('../services/compiqService');
const router = express.Router();


// POST /api/compiq/price
router.post('/price', async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "query" field',
        meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() }
      });
    }
    const result = await analyzeCompiq({ query });
    res.json({ ...result, meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// POST /api/compiq/search
router.post('/search', async (req, res, next) => {
  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "query" field',
        meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() }
      });
    }
    // For now, just return the same as /price (mock)
    const result = await analyzeCompiq({ query });
    res.json({ ...result, meta: { supportedInPhase1: true, usedMockData: true, timestamp: new Date().toISOString() } });
  } catch (err) {
    next(err);
  }
});

// Legacy endpoint for compatibility
router.post('/analyze', async (req, res, next) => {
  try {
    const result = await analyzeCompiq(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
