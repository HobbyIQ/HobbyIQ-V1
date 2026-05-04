const express = require('express');
const router = express.Router();
const playeriqService = require('../services/playeriqService');

// POST /api/playeriq/pricing-summary
router.post('/pricing-summary', async (req, res) => {
  console.log('[PlayerIQ] Incoming pricing request:', req.body);
  if (!req.body || !req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await playeriqService.getPricingSummary(req.body);
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
    const result = await playeriqService.getPricingSummary(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
