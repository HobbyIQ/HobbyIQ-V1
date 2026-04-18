const express = require('express');
const router = express.Router();
const { getPriceResult } = require('../services/compiqService');

// POST /api/compiq/price
router.post('/price', async (req, res) => {
  console.log('[CompIQ] Incoming pricing request:', req.body);
  if (!req.body || !req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await getPriceResult(req.body);
    res.json(result);
  } catch (err) {
    console.error('[CompIQ] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/compiq/search
router.post('/search', async (req, res) => {
  // For now, identical to /price but can be extended for search scenarios
  if (!req.body || !req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await getPriceResult(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// routes/compiq.js
const express = require('express');
const router = express.Router();
const compiqService = require('../services/compiqService');


router.post('/analyze', async (req, res) => {
  try {
    console.log('Incoming request:', req.body);
    if (!req.body || !Array.isArray(req.body.recentComps)) {
      return res.status(400).json({ error: 'recentComps array is required' });
    }
    const result = await compiqService.analyze(req.body);
    res.json(result);
  } catch (err) {
    console.error('CompIQ error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
