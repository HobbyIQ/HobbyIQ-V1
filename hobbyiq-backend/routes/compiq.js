const express = require('express');
const router = express.Router();
const compiqService = require('../services/compiqService');

// POST /api/compiq/price
router.post('/price', async (req, res) => {
  console.log('[CompIQ] Incoming pricing request:', req.body);
  if (!req.body || !req.body.title) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const result = await compiqService.getPriceResult(req.body);
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
    const result = await compiqService.getPriceResult(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
