const express = require('express');
const router = express.Router();
const { getPricingSummary } = require('../services/playeriqService');

// POST /api/playeriq/pricing-summary
router.post('/pricing-summary', async (req, res) => {
  console.log('[PlayerIQ] Incoming pricing request:', req.body);
  if (!req.body || !req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await getPricingSummary(req.body);
    res.json(result);
  } catch (err) {
    console.error('[PlayerIQ] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playeriq/search
router.post('/search', async (req, res) => {
  // For now, identical to /pricing-summary but can be extended for search scenarios
  if (!req.body || !req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await getPricingSummary(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// routes/playeriq.js
const express = require('express');
const router = express.Router();
const playeriqService = require('../services/playeriqService');


router.post('/analyze', async (req, res) => {
  try {
    console.log('Incoming request:', req.body);
    if (!req.body || !req.body.stats) {
      return res.status(400).json({ error: 'stats object is required' });
    }
    const result = await playeriqService.analyze(req.body);
    res.json(result);
  } catch (err) {
    console.error('PlayerIQ error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
